#!/bin/sh
set -eu

cd /usr/share/nginx/backend

mkdir -p /usr/share/nginx/html
cat > /usr/share/nginx/html/config.json <<EOF
{
  "VITE_OIDC_PROVIDER_ID": "${OIDC_NAME:-}"
}
EOF

# Production bootstrap applies migrations and baselines older installations.
# Test containers use the same migration path before starting the application.
# Never push the historical schema: it can drop current payment/API-key data.
if [ "${NODE_ENV:-production}" != "production" ]; then
    node -e "require('./src/prisma/sync-schema').syncDatabaseSchema().catch(error => { console.error(error); process.exit(1); })"
fi

node src/main.js &
backend_pid=$!

while ! nc -z localhost 3000; do
    if ! kill -0 "$backend_pid" 2>/dev/null; then
        wait "$backend_pid"
        exit 1
    fi
    sleep 1
done

exec nginx -g "daemon off;"
