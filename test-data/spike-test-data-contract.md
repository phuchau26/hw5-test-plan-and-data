# Spike Test Data Contract

Status: **DESIGN ONLY — no local credentials or generated orders are included.**

| Input | Execution-time location | Requirement |
|---|---|---|
| Accounts | `test-data/stress_accounts.local.csv` (Git-ignored) | At least 40 rows; first 40 usernames unique; each row has `username,password,shipping_address`. |
| Public account schema | `test-data/spike_accounts.schema.csv` | Column contract only; safe to commit. |
| Public example | `test-data/spike_accounts.example.csv` | Placeholders only; not runnable. |
| Products | `test-data/products.csv` | At least one verified product row with ID/search term/quantity. |

The Spike script maps VU `n` to account row `n` and uses `products.csv` round-robin. Credentials/JWTs must never be copied to report, raw notes, AI records, or Git. Before a future authorized run, the operator must inspect the local account count, uniqueness, lockout state, cart/order state, and backend seed/provision order without printing secret values.
