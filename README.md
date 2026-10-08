# alexa-mcp

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

An MCP server for **Amazon Alexa**: list and control Echo speakers, Echo Shows and Fire TVs, make Alexa speak or announce, run routines, read and control the smart-home devices Alexa knows about (thermostats, lights, plugs, locks, scenes), read and edit shopping/to-do lists, and set or cancel alarms, timers and reminders.

It talks to Amazon's **private** Alexa web API — the one the Alexa app uses — through [`alexa-remote2`](https://github.com/Apollon77/alexa-remote). There is no public API for any of this, so expect occasional breakage when Amazon changes things.

## Sign in once

You sign in to Amazon **in your own browser**; this server never sees your password.

- **In a chat:** ask Claude to sign in to Alexa. It calls `alexa_begin_login` and gives you an amazon.com link. Sign in there (password, two-step code, whatever Amazon asks), and you land on a blank `www.amazon.com/ap/maplanding` page. Paste that page's address back and Claude calls `alexa_finish_login`.
- **Hosted connector:** the sign-in page shows a **Sign in to Amazon** button and a box for that same address.
- **Terminal:** `npx @chrischall/alexa-mcp login` prints the link and reads the pasted address (`--print` also writes the registration as one base64 line for `ALEXA_REGISTRATION`; treat it as a credential).

Under the hood this is the Alexa iOS app's OAuth sign-in with PKCE. The link carries only a challenge, the matching secret stays on the server, and the code in the pasted address is single-use and expires in minutes. Finishing registers a virtual device named **alexa-mcp** on your account and saves the registration (refresh token plus session cookies) to `~/.alexa-mcp/registration.json` (mode 0600). After that no browser is needed: cookies are re-minted from the refresh token every few days. To revoke access, remove the **alexa-mcp** device from your Amazon account (Manage Your Content and Devices → Devices).

## Tools

| Tool | What it does |
|---|---|
| `alexa_list_devices` | Echo speakers, Echo Shows, Fire TVs and other Alexa devices with online status (not thermostats, lights or plugs: those are smart-home) |
| `alexa_get_now_playing` | Media state on one device |
| `alexa_list_volumes` | Volume and mute (only devices Amazon reports, often just a few) |
| `alexa_get_do_not_disturb` | Which devices have Do Not Disturb on |
| `alexa_get_equalizer` | Bass / mid / treble of a speaker or soundbar |
| `alexa_list_bluetooth` | Bluetooth devices paired with each Echo, and what's streaming |
| `alexa_list_routines` | Routines with their triggers |
| `alexa_list_smart_home` | Thermostats, lights, plugs, locks, sensors, groups and scenes, with the actions this server can send to each |
| `alexa_get_smart_home_state` | Live state: thermostat temperature, mode and setpoints, humidity, light on/brightness/colour, lock state, sensors, reachability |
| `alexa_list_lists` / `alexa_get_list_items` | Shopping and to-do lists |
| `alexa_list_alarms_reminders` | Alarms, timers and reminders (with ids for cancelling) |
| `alexa_set_volume` ✋ | Set a device's volume |
| `alexa_playback` ✋ | Play / pause / next / previous |
| `alexa_stop` ✋ | Stop one device (or all of them): music, a ringing alarm, speech |
| `alexa_speak` ✋ | Speak on one device, or announce on several |
| `alexa_run_builtin` ✋ | Play weather, traffic, the news briefing, a joke, a story, calendar and other built-ins out loud |
| `alexa_fire_tv` ✋ | Fire TV on / off / pause / resume / home |
| `alexa_set_do_not_disturb` ✋ | Do Not Disturb on or off |
| `alexa_set_equalizer` ✋ | Set bass / mid / treble |
| `alexa_run_routine` ✋ | Run a routine now |
| `alexa_control_smart_home` ✋ | turnOn / turnOff / setBrightness / setColor / setColorTemperature / sceneActivate / lock (never unlock; no garage doors) |
| `alexa_set_thermostat` ✋ | Thermostat setpoint(s) and/or mode, checked against the thermostat's allowed range |
| `alexa_set_vacation_mode` ✋ | Thermostat vacation / away mode, emulated: saves each thermostat's settings, sets energy-saving setpoints, and restores them when turned off |
| `alexa_create_reminder` ✋ / `alexa_create_timer` ✋ / `alexa_cancel_alarm_reminder` ✋ | Set a reminder, alarm or timer; cancel one |
| `alexa_add_list_item` ✋ / `alexa_update_list_item` ✋ / `alexa_remove_list_item` ✋ | Edit a list: add, check off / un-check, delete |
| `alexa_begin_login` / `alexa_finish_login` | Browser sign-in (see above) |
| `alexa_session_status` | Configuration, no network |
| `alexa_healthcheck` | Does Amazon still accept the session? |

✋ = **confirmation-gated.** A client that supports prompts asks you first; elsewhere (claude.ai, Claude Desktop) the first call sends nothing and returns a preview plus a `confirmToken`, and only a repeat call with that token acts.

**Deliberately left out:**

- **Free-text voice commands** ("Alexa, …", the library's `textCommand`). They can buy things and unlock doors, so no tool sends one.
- **Unlocking** smart locks. `lock` is offered, `unlock` is not: reducing security stays a manual step.

**Vacation mode is an emulation.** Alexa's thermostat API has no vacation, away or eco mode for Amazon Smart Thermostats (only HEAT / COOL / AUTO / OFF), so `alexa_set_vacation_mode` saves each thermostat's mode and setpoints to `~/.alexa-mcp/vacation.json` (mode 0600) before it changes anything, then sets heat-to 55° / cool-to 85° (or what you ask for). Thermostats that are OFF stay OFF. Turning it off restores the saved settings. Turning it on twice is refused, so the originals are never overwritten.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ALEXA_REGISTRATION` | — | Registration JSON, or the base64 line from `login --print`. Optional when the state file exists. |
| `ALEXA_STATE_DIR` | `~/.alexa-mcp` | Where `registration.json` and pending sign-ins live. |
| `ALEXA_AMAZON_PAGE` | `amazon.com` | Amazon site of the account (or what the registration recorded). |
| `ALEXA_ACCEPT_LANGUAGE` | `en-US` | Accept-Language sent to Amazon. |
| `MCP_CONFIRM_MODE` | `ask-user` | `ask-user` / `auto` / `refuse` — whether the model must get your approval in chat before using a `confirmToken`. |
| `MCP_CONFIRM_ELICITATION` | on | `off` skips the confirmation prompt even on clients that declare support. |

When both `ALEXA_REGISTRATION` and the state file are present, the state file wins if it is the same virtual device and at least as new (it is the refreshed copy); otherwise the env var wins (a fresh login).

## Hosting

`mint.yaml` describes the server to [mcp-host](https://github.com/chrischall/mcp-host): one child per user (`identity.perUserChild`), a two-step `auth.flow` (begin → sign in on amazon.com → paste the address), and the registration persists in each user's data dir.

## Development

```sh
npm install
npm test          # typecheck + vitest (no network)
npm run build     # tsc + esbuild bundle (dist/bundle.js is the .mcpb entry)
```

See [`docs/ALEXA-API.md`](docs/ALEXA-API.md) for the verified response shapes and hosts.
