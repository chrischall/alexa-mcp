# Alexa web API — what this server relies on

Everything goes through `alexa-remote2` 8.1.1 / `alexa-cookie2` 5.0.6. Shapes below were captured from a live US account on **2026-10-07** as key structure only (no values recorded). Re-capture before changing a projection in `src/views.ts`.

## Auth

- `alexa-cookie2` proxy login → registration object with keys
  `loginCookie, frc, map-md, deviceId, deviceAppName, deviceSerial, refreshToken, accessToken, tokenDate, macDms, amazonPage, localCookie, csrf, dataVersion`.
  `tokenDate` is epoch **ms**, set on every login/refresh.
- `refreshAlexaCookie({ formerRegistrationData })` mints new cookies from `refreshToken` with no browser and no MFA. Verified locally 2026-10-07: refresh then `getDevices` succeeded (15 devices).
- Cookies last ~14 days; the library recommends refreshing after 5–13. This server refreshes after 4 days, before init.
- Not yet verified: refresh from a datacenter IP (Fly). The spike is blocked on running it; until then hosting is untested.

## Hosts contacted

Recorded by instrumenting `https.request` during `init` + `getDevices` (US account):

| Host | Why |
|---|---|
| `alexa.amazon.com` | endpoint discovery, auth check |
| `na-api-alexa.amazon.com` | the API base (`websiteApiUrl` from discovery — region-dependent) |
| `alexa-comms-mobile-service.amazon.com` | device/comms metadata during init |
| `api.amazon.com` | token refresh (alexa-cookie2) |
| `www.amazon.com` | cookie exchange (alexa-cookie2) and `alexashoppinglists` item writes |

Discovery also returned `api.amazonalexa.com`, `na-bob-dispatch-prod-alexa.amazon.com` (push — disabled here) and `skills-store-na.amazon.com`; none were contacted by the tools above.

## Shapes (abridged)

- `getDevices` → `{ devices: [{ accountName, serialNumber, deviceType, deviceFamily, online, capabilities[], softwareVersion, … }] }`. Families seen: `TABLET, FIRE_TV, ECHO, KNIGHT (Echo Show), VOX, UNKNOWN`. The list includes the virtual device the login registered (filtered out by serial).
- `getAutomationRoutines(limit)` → `[{ automationId, name|null, status, triggers: [{ type, payload: { utterance? … } }], sequence, … }]`.
- `getSmarthomeEntities` → `[{ id, displayName, description, supportedOperations[], supportedProperties[], availability, providerData: { categoryType: APPLIANCE|SCENE|GROUP|VIRTUALGROUP, deviceType: LIGHT|THERMOSTAT|SCENE_TRIGGER|… } }]`. Operations seen include `turnOn, turnOff, setBrightness, rampBrightness, sceneActivate, setColor, setColorTemperature, setTargetTemperature` and vendor-specific `setModeValue@…`.
- `executeSmarthomeDeviceAction([id], { action, … }, 'APPLIANCE'|'GROUP')` → `PUT /api/phoenix/state`, answers `{ controlResponses, errors }` — **a 200 can carry per-entity errors** (`ENDPOINT_UNREACHABLE`).
- `getListsV2` → `[{ listId, listType: SHOP|TODO, aggregatedAttributes: { totalActiveItemsCount }, … }]`; `getListItemsV2(listId)` → `[{ itemId, itemName, itemStatus, version, quantity, note, … }]`. `deleteListItem` requires the item's current `version`.
- `getNotifications(false)` → `{ notifications: [{ type, status, reminderLabel, timerLabel, deviceSerialNumber, originalDate, originalTime, recurringPattern, … }] }`.
- `getAllDeviceVolumes` → `{ volumes: [{ dsn, speakerVolume, speakerMuted, alertVolume, … }] }` — returned only ONE device on the test account; most Echo volumes are not reported here.

## Writes verified live (2026-10-07)

- **Volume** — `sendSequenceCommand(serial, 'volume', n)` moved a soundbar 20 → 21 → 20, confirmed by re-reading `getAllDeviceVolumes`. The player form `sendCommand(serial, 'volume', n)` was accepted with no error and changed NOTHING while idle — do not use it.
- **List items** — `addListItem` then `deleteListItem` (with the item's `version`) on the to-do list, each confirmed by re-reading `getListItemsV2`.

Not exercised live (audible or physical in the house): `speak`, `announcement`, playback, routines, smart-home actions. They use the library's documented call shapes and are unit-tested.
