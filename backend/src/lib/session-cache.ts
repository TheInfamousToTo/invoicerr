import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import { logger } from '@/logger/logger.service';
import prisma from '@/prisma/prisma.service';

import { createLibRedisClient } from './redis-connection';

/**
 * A short, per-process cache of the enriched session `AuthGuard` resolves on every request, kept
 * correct across API replicas through Redis.
 *
 * Every write that changes what a cached session holds records an invalidation for the users it
 * touches: `invalidateUsers` bumps a global sequence and stamps each user with it. A cache entry
 * remembers the sequence read BEFORE its session was loaded, and is served only while no stamp of
 * its user is newer. One `MGET` per cached request checks that; a miss costs one extra script call.
 *
 * Fails closed: without a working Redis the session is always loaded, never served from memory.
 */
export interface SessionCache {
  read<T extends CacheableSession>(cookie: SessionCookie, load: () => Promise<T | null>): Promise<T | null>;
  invalidateUsers(userIds: readonly string[]): Promise<void>;
  invalidateAll(): Promise<void>;
  close(): Promise<void>;
}

export interface CacheableSession {
  user: { id: string };
  session: { token: string; expiresAt: Date | string };
}

export interface SessionCookie {
  /** The raw `Cookie` request header. */
  header: string | undefined;
  /** The session cookie's name, as better-auth names it. */
  name: string;
}

export interface SessionCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  redis: () => Redis;
  keyPrefix?: string;
  now?: () => number;
}

interface Entry {
  value: CacheableSession;
  userId: string;
  generation: string;
  sequence: number;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
// Invalidation stamps outlive any entry they could concern.
const STAMP_MARGIN_MS = 60_000;
const INVALIDATION_CONNECT_TIMEOUT_MS = 2_000;

// Losing either key (flush, restart) starts a new generation, which disowns every existing entry.
const SNAPSHOT_SCRIPT = `
local generation = redis.call('GET', KEYS[1])
local sequence = redis.call('GET', KEYS[2])
if not generation or not sequence then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], 0)
  return {ARGV[1], '0'}
end
return {generation, sequence}`;

const INVALIDATE_SCRIPT = `
if not redis.call('GET', KEYS[1]) or not redis.call('GET', KEYS[2]) then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], 0)
end
local sequence = redis.call('INCR', KEYS[2])
for i = 3, #KEYS do redis.call('SET', KEYS[i], sequence, 'PX', ARGV[2]) end
return sequence`;

export function createSessionCache(options: SessionCacheOptions): SessionCache {
  const { ttlMs } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const prefix = options.keyPrefix ?? '{session-cache}';
  const now = options.now ?? Date.now;
  const generationKey = `${prefix}:generation`;
  const sequenceKey = `${prefix}:sequence`;
  const userKey = (userId: string) => `${prefix}:user:${userId}`;
  const entries = new Map<string, Entry>();
  let client: Redis | null = null;

  function redis(): Redis | null {
    client ??= options.redis();
    return client.status === 'ready' ? client : null;
  }

  // Invalidations wait for the connection: dropping one would leave other replicas serving it.
  async function connectedRedis(): Promise<Redis> {
    client ??= options.redis();
    const connection = client;
    if (connection.status === 'ready') return connection;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis not ready')), INVALIDATION_CONNECT_TIMEOUT_MS);
      connection.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return connection;
  }

  async function isCurrent(entry: Entry, connection: Redis): Promise<boolean> {
    const [generation, stamp] = await connection.mget(generationKey, userKey(entry.userId));
    return generation === entry.generation && Number(stamp ?? 0) <= entry.sequence;
  }

  function store(key: string, entry: Entry): void {
    entries.delete(key);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, entry);
  }

  return {
    async read(cookie, load) {
      const value = ttlMs > 0 ? singleCookieValue(cookie) : undefined;
      const connection = value === undefined ? null : redis();
      if (value === undefined || !connection) return load();

      let snapshot: [string, string];
      try {
        const cached = entries.get(value);
        if (cached && cached.expiresAt > now() && (await isCurrent(cached, connection))) {
          return structuredClone(cached.value) as Awaited<ReturnType<typeof load>>;
        }
        entries.delete(value);
        snapshot = (await connection.eval(SNAPSHOT_SCRIPT, 2, generationKey, sequenceKey, randomUUID())) as [
          string,
          string,
        ];
      } catch (error) {
        logger.warn('Session cache unavailable, loading the session directly', {
          category: 'auth',
          details: { message: error instanceof Error ? error.message : String(error) },
        });
        return load();
      }

      const session = await load();
      if (session && session.session.token === unsignedToken(value)) {
        const [generation, sequence] = snapshot;
        store(value, {
          value: structuredClone(session),
          userId: session.user.id,
          generation,
          sequence: Number(sequence),
          expiresAt: Math.min(now() + ttlMs, new Date(session.session.expiresAt).getTime()),
        });
      }
      return session;
    },

    async invalidateUsers(userIds) {
      const unique = [...new Set(userIds)];
      for (const userId of unique) {
        for (const [key, entry] of entries) if (entry.userId === userId) entries.delete(key);
      }
      if (unique.length === 0) return;
      try {
        const connection = await connectedRedis();
        await connection.eval(
          INVALIDATE_SCRIPT,
          2 + unique.length,
          generationKey,
          sequenceKey,
          ...unique.map(userKey),
          randomUUID(),
          Math.max(ttlMs, 0) + STAMP_MARGIN_MS,
        );
      } catch (error) {
        logger.error('Session cache invalidation could not reach Redis', {
          category: 'auth',
          details: { userIds: unique, message: error instanceof Error ? error.message : String(error) },
        });
      }
    },

    async invalidateAll() {
      entries.clear();
      try {
        await (await connectedRedis()).set(generationKey, randomUUID());
      } catch (error) {
        logger.error('Session cache invalidation could not reach Redis', {
          category: 'auth',
          details: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    },

    async close() {
      entries.clear();
      if (client) client.disconnect();
      client = null;
    },
  };
}

/** The session cookie's value, or `undefined` unless the header carries it exactly once. */
function singleCookieValue({ header, name }: SessionCookie): string | undefined {
  if (!header) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf('=')) === name)
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] ? values[0] : undefined;
}

function unsignedToken(cookieValue: string): string | undefined {
  try {
    const decoded = decodeURIComponent(cookieValue);
    const dot = decoded.lastIndexOf('.');
    return dot > 0 ? decoded.slice(0, dot) : undefined;
  } catch {
    return undefined;
  }
}

export function readSessionCacheTtlMs(): number {
  const DEFAULT_TTL_MS = 10_000;
  const raw = process.env.SESSION_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function createSessionCacheRedisClient(): Redis {
  const client = createLibRedisClient({
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    lazyConnect: true,
  });
  client.on('error', () => undefined);
  client.connect().catch(() => undefined);
  return client;
}

export const sessionCache: SessionCache = createSessionCache({
  ttlMs: readSessionCacheTtlMs(),
  redis: createSessionCacheRedisClient,
});

export async function memberIdsOf(companyId: string): Promise<string[]> {
  const members = await prisma.userCompany.findMany({ where: { companyId }, select: { userId: true } });
  return members.map((member) => member.userId);
}
