// Run after npm ci in backend and frontend: node --test scripts/security-regression.test.cjs
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

for (const app of ['backend', 'frontend']) {
  const appRequire = createRequire(path.resolve(__dirname, '..', app, 'package.json'));
  const Handlebars = appRequire('handlebars');

  test(`${app}: invoice templates still render and escape HTML`, () => {
    const render = Handlebars.compile('{{client}}: {{#each items}}{{name}}={{amount}};{{/each}}');
    assert.equal(render({ client: '<Client>', items: [{ name: 'Service', amount: 42 }] }),
      '&lt;Client&gt;: Service=42;');
  });

  // GHSA-8r5x-fm3f-whwj: malformed AST metadata must never become executable code.
  test(`${app}: rejects injected block parameter metadata`, () => {
    const ast = Handlebars.parse('{{#if ok}}invoice{{/if}}');
    ast.body[0].program.blockParams = { length: '(()=>{throw new Error("SECURITY_SENTINEL")})()' };
    assert.throws(() => Handlebars.compile(ast)({ ok: true }),
      error => !error.message.includes('SECURITY_SENTINEL'));
  });

  // GHSA-p8wg-vrv2-v86f: an own constructor on a prototype must remain inaccessible.
  test(`${app}: blocks Function constructor lookup on a prototype`, () => {
    const render = Handlebars.compile('{{lookup target "constructor"}}');
    assert.equal(render({ target: Function.prototype }, { allowProtoMethodsByDefault: true }), '');
  });
}

const backendRequire = createRequire(path.resolve(__dirname, '..', 'backend/package.json'));

test('proxy trust does not treat unrelated IPv4 clients as trusted IPv6 proxies', () => {
  const proxyaddr = backendRequire('proxy-addr');
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/8')('203.0.113.10'), false);
  const trust = proxyaddr.compile('10.0.0.0/8');
  assert.equal(trust('10.1.2.3'), true);
  assert.equal(trust('203.0.113.10'), false);
});

test('simple-git rejects trailer commands before invoking Git', async () => {
  const { simpleGit } = backendRequire('simple-git');
  await assert.rejects(
    simpleGit({ config: ['trailer.security.cmd=echo SECURITY_SENTINEL'] }).raw(['version']),
    /unsafe|trailer|not permitted|not allowed/i,
  );
});
