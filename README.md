# alexa-mcp

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

An MCP server for **Amazon Alexa**: list and control Echo speakers, Echo Shows and Fire TVs, make Alexa speak or announce, run routines, control the smart-home devices and scenes Alexa knows about, read and edit shopping/to-do lists, and see alarms, timers and reminders.

It talks to Amazon's **private** Alexa web API — the one the Alexa app uses — through [`alexa-remote2`](https://github.com/Apollon77/alexa-remote). There is no public API for any of this, so expect occasional breakage when Amazon changes things.

## Sign in once

```sh
npx @chrischall/alexa-mcp login            # add --print for a hosted connector
```

It opens a local page at `http://127.0.0.1:3456/` that fronts Amazon's real sign-in. Use a desktop browser **without** the Alexa app installed, and complete whatever Amazon asks (password, 2FA, captcha). The login registers a virtual Alexa-app device named **alexa-mcp** on your account and saves its registration — a refresh token plus session cookies — to `~/.alexa-mcp/registration.json` (mode 0600).

After that no browser is needed: cookies are re-minted from the refresh token every few days and the refreshed registration is written back to the same file. To revoke access, remove the **alexa-mcp** device from your Amazon account (Manage Your Content and Devices → Devices).

`--print` also writes the registration to stdout as one base64 line. It is a credential — paste it only into `ALEXA_REGISTRATION` (e.g. a hosted connector's sign-in form), never into a chat.

## Tools

| Tool | What it does |
|---|---|
| `alexa_list_devices` | Echo/Fire TV/other Alexa devices with online status |
| `alexa_get_now_playing` | Media state on one device |
| `alexa_list_volumes` | Volume and mute (only devices Amazon reports — often just a few) |
| `alexa_list_routines` | Routines with their triggers |
| `alexa_list_smart_home` | Smart-home devices, groups and scenes, with the actions this server can send |
| `alexa_list_lists` / `alexa_get_list_items` | Shopping and to-do lists |
| `alexa_list_alarms_reminders` | Alarms, timers and reminders |
| `alexa_set_volume` ✋ | Set a device's volume |
| `alexa_playback` ✋ | Play / pause / next / previous |
| `alexa_speak` ✋ | Speak on one device, or announce on several |
| `alexa_run_routine` ✋ | Run a routine now |
| `alexa_control_smart_home` ✋ | turnOn / turnOff / setBrightness / sceneActivate (no locks, garage doors or thermostats) |
| `alexa_add_list_item` ✋ / `alexa_remove_list_item` ✋ | Edit a list |
| `alexa_session_status` | Configuration, no network |
| `alexa_healthcheck` | Does Amazon still accept the session? |

✋ = **confirmation-gated.** A client that supports prompts asks you first; elsewhere (claude.ai, Claude Desktop) the first call sends nothing and returns a preview plus a `confirmToken`, and only a repeat call with that token acts. Arbitrary voice commands ("Alexa, …") are deliberately **not** exposed: they can buy things and unlock doors.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ALEXA_REGISTRATION` | — | Registration JSON, or the base64 line from `login --print`. Optional when the state file exists. |
| `ALEXA_STATE_DIR` | `~/.alexa-mcp` | Where `registration.json` (and the login proxy's temp device file) live. |
| `ALEXA_AMAZON_PAGE` | `amazon.com` | Amazon site of the account (or what the registration recorded). |
| `ALEXA_ACCEPT_LANGUAGE` | `en-US` | Accept-Language sent to Amazon. |
| `MCP_CONFIRM_MODE` | `ask-user` | `ask-user` / `auto` / `refuse` — whether the model must get your approval in chat before using a `confirmToken`. |
| `MCP_CONFIRM_ELICITATION` | on | `off` skips the confirmation prompt even on clients that declare support. |

When both `ALEXA_REGISTRATION` and the state file are present, the state file wins if it is the same virtual device and at least as new (it is the refreshed copy); otherwise the env var wins (a fresh login).

## Hosting

`mint.yaml` describes the server to [mcp-host](https://github.com/chrischall/mcp-host): one child per user (`identity.perUserChild`), each user pastes their own `ALEXA_REGISTRATION` on the sign-in page, and the refreshed registration persists in the child's data dir.

## Development

```sh
npm install
npm test          # typecheck + vitest (no network)
npm run build     # tsc + esbuild bundle (dist/bundle.js is the .mcpb entry)
```

See [`docs/ALEXA-API.md`](docs/ALEXA-API.md) for the verified response shapes and hosts.
