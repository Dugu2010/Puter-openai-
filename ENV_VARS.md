# Environment variables

| Variable          | Required | Default                  | Purpose                                                                       |
| ----------------- | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `PUTER_API_KEY`   | yes      | —                        | Puter auth token (puter.com/dashboard → Create token)                          |
| `PUTER_MODE`      | no       | `driver`                 | `driver` = free user-pays path; `official` = paid OpenAI-compatible endpoint   |
| `PUTER_API_BASE`  | no       | `https://api.puter.com`  | Override the upstream base URL                                                |
| `GATEWAY_API_KEY` | no       | (open access)            | When set, clients must send `Authorization: Bearer <GATEWAY_API_KEY>`         |
| `PUTER_TIMEOUT_MS`| no       | `120000`                 | Upstream timeout in ms                                                        |

For local development, create `.env.local` with at least `PUTER_API_KEY=<your token>`.
See also README.md.
