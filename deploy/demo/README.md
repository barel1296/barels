# Interactive dashboard demo

The **real** platform build and the **real** admin dashboard, with two demo influencers and their sample data:

- **Luna Vale:** persona, content, plans, fans, payments, analytics.
- **Nova Reyes:** cloned from Luna, then given her own persona, bot, fans, a product and a post.

Everything external is **simulated** inside the demo process:

- Telegram (including Stars payments and refunds);
- Instagram;
- the local LLM;
- ComfyUI, behind the real VEC bridge.

It never contacts Telegram, Meta, a model, the RTX 5090 workstation or any production system.

## Option A: private HTTPS preview in GitHub Codespaces (recommended)

GitHub Codespaces runs the repository's dev container (`.devcontainer/`). It is free within the monthly Codespaces quota of personal GitHub accounts; with the default spending limit of $0, nothing beyond the quota is billed. You get an HTTPS URL that **only you** can open, behind two logins: GitHub, then the dashboard.

1. Open the repository on GitHub and switch to the branch **`claude/magical-knuth-jep6jf`**.
2. Click **Code → Codespaces → Create codespace on claude/magical-knuth-jep6jf** (2 cores are enough).
3. Wait for the first start, about 3–5 minutes:
   - the container is built, `npm ci` and the build run;
   - `deploy/demo/start.sh` seeds the demo. Its terminal ends with "Dashboard demo is ready".
4. Open the **Ports** tab. Port **8090, "Dashboard demo (private)"** has a URL like `https://<codespace-name>-8090.app.github.dev`. Open it and add **`/admin/`**.
   - **Leave the port visibility Private.** Never set it to Public.
5. Sign in to the dashboard:
   - **Email and password:** open `.demo/demo-credentials.txt` in the Codespace editor. The file is generated at each start, readable only inside the Codespace, and never committed.
   - **6-digit code:** in the Codespace terminal run `cd apps/platform && npm run demo:totp -- --out ../../.demo`. Or add the TOTP secret from the same file to an authenticator app.

**Shut down:**

| What | How |
|---|---|
| Stop the demo, keep the Codespace | `deploy/demo/stop.sh` (restart: `deploy/demo/start.sh`) |
| Stop the Codespace | github.com/codespaces → ⋯ → **Stop codespace**. It also stops by itself after the idle timeout (30 min by default). The URL stops working when it is stopped |
| Remove everything | github.com/codespaces → ⋯ → **Delete**. This deletes the container, the database volume, the generated credentials and the URL |

## Option B: on your own computer

- **With Docker Desktop and VS Code:** install the *Dev Containers* extension, open the repository, run **Reopen in Container**, then open `http://127.0.0.1:8090/admin/`. The setup is the same as Option A and nothing leaves your machine.
- **With Node.js 22 and a development PostgreSQL 16** (not a server with a real installation):

  ```bash
  DEMO_PG_ADMIN_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres deploy/demo/start.sh
  # open http://127.0.0.1:8090/admin/ ; stop with deploy/demo/stop.sh
  ```

## How the demo is kept safe

- **Database:** PostgreSQL runs in the dev container with **no published port**, and its password is random per Codespace (`.devcontainer/.env`, git-ignored). The demo uses its own database `golden_demo` and resets the runtime role passwords: never point it at a server with a real installation.
- **Network:** the platform and the simulators listen on `127.0.0.1` only. Codespaces forwards only port 8090, and only privately; other ports are never auto-forwarded.
- **Sign-in:** every API route needs a session (signing in requires password **and** TOTP) or an API token; anonymous requests get `401`.
- **Throwaway credentials:**
  - generated at every start;
  - written only to `.demo/demo-credentials.txt` (mode 600, in a mode-700, git-ignored folder);
  - never printed to the console or logs.
- **Integrations:** the bot tokens, the Instagram account and every payment exist only in the in-process simulators. Publishing and Stars payments go to them, so nothing is posted or charged anywhere.

## Good to know

- **Every start recreates the demo database** from the same seed, so changes you make while reviewing are reset on the next start. Keep the demo running while you review.
- **The images are solid-colour placeholders** from the simulated ComfyUI. Real images come from Track A's workflows on the workstation.
- **The two weeks of follower and member history in Analytics are synthetic.** Everything else was created through the platform's own API.
- **Generated content and chats can be approved for real in the dashboard.** "Publishing" and "payments" then happen in the simulators.
- **Why there is no tunnel from the development container:** its network policy blocks the free tunnel services (`api.trycloudflare.com`, `connect.ngrok-agent.com`, `loca.lt`, `localhost.run`) and allows no inbound connections.
- **Status:** the dev container configuration has been validated, and `start.sh` and `stop.sh` were run in the development container. The Codespace itself has not been started from here.
