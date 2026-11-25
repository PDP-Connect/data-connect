# Get and install DataConnect

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 1. Get and install DataConnect

**Who starts it:** person. **Where:** Releases page or chosen deployment docs. **Forms:** desktop, Docker, Fly.io, Railway, source. **Evidence:** V for README and deployment docs; I for operating-system dialogs that the app cannot render.

1. [V] **Desktop download.** Open the repository Releases page and download the artifact for the operating system. The root README says: “Use the Releases page for binary downloads when a release is available.” Artifacts are manual installs; “This build does not include an in-app auto-updater.” [README.md:8-18,30-45] The branch packages `dmg`, `app`, `nsis`, `appimage`, and `deb`; Linux deb depends on `libayatana-appindicator3-1`; Windows NSIS uses current-user install mode. [src-tauri/tauri.conf.json:34-75]
2. [V] **macOS.** Open the DMG and install the app. If macOS blocks an unsigned build, the README describes clearing the app's quarantine flag, then reopening it. Some macOS artifacts are unsigned. [README.md:13-18,34-37] There is no in-app permission dialog in the code cited here. Any Gatekeeper prompt is macOS-owned, and the repository does not specify its exact text or a universal permission sequence. **Rough edge:** unsigned status and bypass command are user-visible but no signing explanation is in the installer itself.
3. [V] **Windows.** Run the NSIS installer and follow its prompts. Installer is current-user. [README.md:39-42; src-tauri/tauri.conf.json:71-75] The branch does not specify exact Windows SmartScreen text or permission prompts. Do not treat their wording as DataConnect copy.
4. [V] **Linux.** Install `.deb` or run `.AppImage`. The deb installs an AppArmor profile for Chromium and the appindicator dependency. [README.md:43-45; src-tauri/tauri.conf.json:58-69] The README does not document package-manager prompts or the AppImage executable-bit step.
5. [V] **Docker quickstart.** Type the documented `docker run` command. It publishes host `127.0.0.1:7662` to container `3000`, persists `pdpp_data`, and follows the startup logs. [deploy/docker/README.md:58-97]

   ```sh
   docker run -d --name pdpp --restart unless-stopped \
     --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
     -p 127.0.0.1:7662:3000 \
     -e PDPP_BIND_HOST=127.0.0.1 \
     -e PDPP_REFERENCE_ORIGIN=http://localhost:7662 \
     -e PDPP_TRUSTED_HOSTS=localhost,127.0.0.1 \
     -v pdpp_data:<container-data-directory> \
     ghcr.io/pdp-connect/data-connect/core:0.7.62 && docker logs -f pdpp
   ```

   `Ctrl-C` stops following logs, not the container. On first boot, the terminal shows a one-time `setupToken`; open `http://localhost:7662/setup`, paste it, and choose the owner password. The first request may show a startup page that retries; wait for the dashboard. [deploy/docker/README.md:76-97]

6. [V] **Docker production.** Download three files; generate secrets into `.env`; pull and start Compose. The person needs OpenSSL and Docker Compose. [deploy/docker/README.md:127-150]

   ```sh
   mkdir pdpp && cd pdpp
   for file in docker-compose.yml .env.example generate-secrets.sh; do
     curl -fsSLO "https://raw.githubusercontent.com/PDP-Connect/data-connect/main/deploy/docker/$file"
   done
   umask 077
   cp .env.example .env
   bash generate-secrets.sh --write .env
   docker compose --env-file .env pull
   docker compose --env-file .env up -d
   ```

   Leave `PDPP_OWNER_PASSWORD` empty to claim at `/setup` with the token in `docker compose --env-file .env logs core`; or set the password before start to skip the wizard. Keep `.env` and backups safe. [deploy/docker/README.md:146-150]

7. [V] **Fly.io.** The selected image-backed path needs a Fly organization with a payment method. In a terminal, type the documented command. It creates the app, provisions Postgres, deploys the Core image, prints its origin, and follows logs. Use the setup token from `fly logs` at `/setup`. [deploy/flyio/README.md:30-40]

   ```sh
   APP="pdpp-core-$(openssl rand -hex 3)"
   fly launch \
     --image ghcr.io/pdp-connect/data-connect/core:latest \
     --name "$APP" \
     --region iad \
     --internal-port 3000 \
     --db \
     --env "PDPP_REFERENCE_ORIGIN=https://$APP.fly.dev" \
     --no-github-workflow \
     --no-object-storage \
     --no-redis \
     --now \
     --yes
   printf 'Origin: https://%s.fly.dev\n' "$APP"
   fly logs --app "$APP"
   ```

   The slower source-build path uses `fly launch --from https://github.com/PDP-Connect/data-connect --config deploy/flyio/fly.toml --name "$APP" --region iad --copy-config --build-target core --db --env "PDPP_REFERENCE_ORIGIN=https://$APP.fly.dev" --no-github-workflow --no-object-storage --no-redis --now --yes`, then prints the origin and follows logs. [deploy/flyio/README.md:42-83]

8. [V] **Railway.** Click the published “Deploy on Railway” template button, or create the documented Core + Postgres services. The published template uses the bundled `core:latest` image. Generate the public domain; first deployment logs contain the setup token; open the resulting origin at `/setup`. An operator can set `PDPP_OWNER_PASSWORD` as a Railway secret to bypass setup. [deploy/railway/README.md:16-38,73-89,136-145,169-182]
9. [V] **From source.** Clone, install, run Tauri dev. To package, run `npm run tauri:build`. Requirements: Node.js 24.15+, Rust stable, Tauri OS prerequisites, network. [README.md:47-82]

The deployment guides found under `deploy/` document Docker, Fly.io, and Railway. No other hosted-provider guide or one-click template appears in this branch’s deployment tree. [deploy/docker/README.md:5-18,288-294; deploy/flyio/README.md:1; deploy/railway/README.md:1]

```sh
git clone https://github.com/PDP-Connect/data-connect.git
cd data-connect
npm install
npm run tauri:dev
```

**What appears first:** for Docker/Fly/Railway first boot it is `/setup` after the startup page; for source/desktop it is the app console after sidecars start (details in Basecheck). **Rough edges:** the Docker README pins Core `0.7.62`, while `tauri.conf.json` in this branch says desktop `0.7.63`. The public README says current release artifacts may not be available. No exact OS warning copy is owned by the repository.

## Driving it with Playwright

**Journey status:** `no`; no feature journey is declared. **Result:** `not run`.

**Reachability:** No install journey is declared. The web baseline is not an installer or first-boot test.

**Stops at:** Release hosting, OS installers, container deployment, and first-boot setup are outside this browser-only stack.

There is no honest feature-flow command for this precondition. The all-route baseline records only route presence when the path is listed; it does not turn a missing consent request, installer, or native desktop state into a feature pass.

## Gotchas

The product’s install flows run through OS installers or deployment instructions. The user forbids launching the Tauri app.
