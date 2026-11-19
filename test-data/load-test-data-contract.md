# Load-test data contract — DESIGN ONLY

| File | Committed? | Required columns | Consumer | Rule |
|---|---|---|---|---|
| `credentials.local.csv` | No; Git-ignored | `username,password,shipping_address` | `23120252_Load_20261117.js` | At least ten authorized isolated local test accounts; one row per maximum VU. |
| `products.csv` | Yes; no secret | `product_id,search_term,quantity` | Load script | IDs/terms must be confirmed on the actual SUT baseline before every campaign. |
| `orders.csv` | Yes; no secret | `address,phone,payment_method` | Documentation only at this stage | The verified checkout API currently consumes only `shipping_address`; do not invent unsupported fields in the k6 payload. |

The script performs a 1:1 mapping from k6 `idInTest` values 1–10 to the first ten account rows. Its submitted checkout address comes from the account row, so no address must be generated during execution. Product details come from the response, not from hard-coded price/name values.
