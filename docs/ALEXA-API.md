# Alexa web API — what this server relies on

Everything goes through `alexa-remote2` 8.1.1 / `alexa-cookie2` 5.0.6. Shapes below were captured from a live US account on **2026-10-07** as key structure only (no values recorded). Re-capture before changing a projection in `src/views.ts`.

## Auth

- **Sign-in (browser, PKCE)** — `browser-login.ts`. The link is `https://www.amazon.com/ap/signin?…` with the Alexa iOS app parameters (`assoc_handle=amzn_dp_project_dee_ios`, `openid.oa2.client_id=device:<deviceId>`, `scope=device_auth_access`, `response_type=code`, `code_challenge_method=S256`). After the user signs in, Amazon redirects to `https://www.amazon.com/ap/maplanding?…&openid.oa2.authorization_code=<code>`. `POST https://api.amazon.com/auth/register` with `auth_data { client_id: deviceId, authorization_code, code_verifier, code_algorithm: SHA-256, client_domain: DeviceLegacy }` returns `response.success.tokens { bearer { refresh_token, access_token }, mac_dms, website_cookies[] }`. Verified live 2026-10-07 from a phone sign-in: register HTTP 200, 5 website cookies.
- **Completion** — alexa-cookie2 `refreshAlexaCookie({ formerRegistrationData })` needs a non-empty `loginCookie` (built from `website_cookies`) plus `refreshToken`; it mints `localCookie` + `csrf`. Then `getDevices` succeeded (14 devices).
- **Registration keys** — `deviceId, deviceSerial, deviceAppName, frc, map-md, refreshToken, accessToken, macDms, amazonPage, tokenDate, loginCookie, localCookie, csrf, dataVersion`. `tokenDate` is epoch **ms**.
- `refreshAlexaCookie` re-mints cookies from the refresh token with no browser and no MFA. Cookies last ~14 days; this server refreshes after 4. Verified from a datacenter IP 2026-10-07: a Fly machine in `ewr` (egress 66.225.222.71) refreshed and then read all 15 devices.
- A code is single-use and expires in minutes. Save the token seed the moment `/auth/register` answers: an unsaved success still leaves a device on the account.

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
