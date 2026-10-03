# Security policy

This package protects application quotas; it does not authenticate users or absorb network-level denial-of-service attacks.

Use identities supplied by trusted authentication middleware. Restrict reverse-proxy trust to infrastructure you control. Keep Redis and PostgreSQL private, use appropriate TLS and credentials, and avoid Redis eviction policies that discard active quotas.

The Express and other HTTP adapters deny with 503 when quota storage fails unless the application explicitly chooses fail-open behaviour.

Please use GitHub private vulnerability reporting for security issues if the repository has enabled it. If that feature is unavailable, open an issue requesting a private contact without posting exploit details or credentials. No response-time or availability SLA is promised by this community package.
