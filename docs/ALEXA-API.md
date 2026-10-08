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

## Verified live (2026-10-08)

- **Smart-home state** — `querySmarthomeDevices(ids, 'APPLIANCE')` takes **applianceIds**, not entity ids. Map them with `getSmarthomeDevicesV2()` (the `/nexus/v1/graphql` endpoints list): each item has `legacyAppliance { applianceId, entityId, friendlyName, … }` and `displayCategories.primary.value` (`THERMOSTAT`, `LIGHT`, …). `legacyAppliance.entityId` equals `getSmarthomeEntities()[i].id`, the id `executeSmarthomeDeviceAction` uses. The answer is `{ deviceStates: [{ entity, capabilityStates[], error }], errors: [{ code, message, entity }] }`. **Some `capabilityStates` elements are JSON strings**; each parses to `{ namespace, name, instance?, value }`. Seen on a light: `Alexa.PowerController powerState`, `Alexa.BrightnessController brightness`, `Alexa.ModeController mode (instance Light.Effect)`, `Alexa.EndpointHealth connectivity {value}`. Seen on a thermostat: `Alexa.TemperatureSensor temperature / preciseTemperature {value, scale}`, `Alexa.HumiditySensor relativeHumidity`, `Alexa.ThermostatController thermostatMode`, `lowerSetpoint` / `upperSetpoint` (AUTO; single-setpoint modes use `targetSetpoint`) `{value, scale}`, `Alexa.ThermostatController.HVAC.Components coolerOperation / primaryHeaterOperation / fanOperation`, `Alexa.ThermostatController.Configuration allowedTemperatureRange {heating: {minimum, maximum}, …}` and `temperatureScale`.
- **Thermostat setpoint, dual (AUTO) form** — `executeSmarthomeDeviceAction([entityId], { action: 'setTargetTemperature', 'upperSetTemperature.value', 'upperSetTemperature.scale': 'fahrenheit', 'lowerSetTemperature.value', 'lowerSetTemperature.scale' }, 'APPLIANCE')` answered `controlResponses[0].code SUCCESS`; a re-read showed the new upper setpoint (then restored). The server always sends BOTH bounds, filling the missing one from a fresh read.
- **Thermostat modes (Amazon Smart Thermostat, 3 units)** — `ThermostatController` supportedModes are only `HEAT / COOL / AUTO / OFF`: no `ECO`, `AWAY` or `VACATION`. Also a `ModeController` "Fan Mode" (`"1"` On, `"2"` Auto, `"3"` Circulate) and `RangeController`s for display brightness (neither is exposed here).
- **Do Not Disturb** — `getDoNotDisturb()` → `{ doNotDisturbDeviceStatusList: [{ deviceSerialNumber, deviceType, enabled }] }`; `setDoNotDisturb(serial, enabled)` toggled it, confirmed by re-read.
- **Equalizer** (a soundbar) — `getEqualizerSettings(serial)` → `{ bass, mid, treble }`; `setEqualizerSettings(serial, bass, mid, treble)` echoed and re-read the new values. Devices without `EQUALIZER_CONTROLLER_*` capabilities are refused before any call.
- **Reminders** — `createNotificationObject(serial, 'Reminder', label, timeMs, 'ON')` (synchronous, no callback) then `createNotification(obj)` returned the created notification with an `id` (a soundbar); `deleteNotification(obj)` with that object removed it. A **Fire TV refused** a reminder (`no JSON`, no `id`), so an answer without `id` is treated as a failure. Only devices with `REMINDERS` (reminders) or `TIMERS_AND_ALARMS` (alarms, timers) capabilities are offered.
- **Bluetooth** — `getBluetooth(false)` → `{ bluetoothStates: [{ deviceSerialNumber, friendlyName, online, pairedDeviceList, streamingState, … }] }`.

- **Device modes** (`alexa_set_device_mode`) — `executeSmarthomeDeviceAction([entityId], { action: 'setModeValue', instance: '<instance>', mode: '<value>' }, 'APPLIANCE')` answered `controlResponses[0].code SUCCESS` and the state re-read changed: a thermostat's Fan Mode (instance `5`) set to `3` Circulate, then restored to `1` On. These forms FAILED with `FAILURE_TO_SEND` in `controlResponses` (now treated as a failure): `{ action: 'setModeValue@…_5', mode }` and `{ action: 'setModeValue@…_5', 'mode.value' }`. The instance is everything after the first `_` following the uuid in a `setModeValue@<uuid>_<instance>` supportedOperation (`5`, `Robot.MobilityState`, `Light.Effect`). Names and values come from `getSmarthomeDevicesV2()[i].legacyAppliance.capabilities[]` where `interfaceName === 'Alexa.ModeController'` and `instance` matches: `resources.friendlyNames[].value.text` (or `.assetId`) and `configuration.supportedModes[] { value, modeResources.friendlyNames[] }` (instance 5 = "Fan Mode": 1 On, 2 Auto, 3 Circulate). The current value is the `Alexa.ModeController` `mode` state with that `instance`. When a device declares no values, the given value is sent as-is.

## Built to documented shapes, NOT live-verified

These are audible, physical, or untested forms. They follow the library's documented call shapes and are unit-tested only.

- `speak`, `announcement`, playback, routines, `turnOn / turnOff / setBrightness / sceneActivate` (from 2026-10-07).
- **Thermostat single setpoint** (HEAT / COOL): `{ action: 'setTargetTemperature', 'targetTemperature.value', 'targetTemperature.scale' }`.
- **Thermostat mode**: `{ action: 'setThermostatMode', 'thermostatMode.value': 'HEAT'|'COOL'|'AUTO'|'OFF'|'ECO' }` (`ECO` is accepted by the tool, but the Amazon Smart Thermostat does not list it).
- **Light colour**: `{ action: 'setColor', colorName }` and `{ action: 'setColorTemperature', colorTemperatureName }`.
- **Locks** (`alexa_lock`; the account has no lock): `{ action: 'lockAction', 'targetLockState.value': 'LOCKED' }` and `{ action: 'unlockAction', 'targetLockState.value': 'UNLOCKED' }`, each offered only when the entity lists that operation. Both the operation names and the parameter key are assumptions from the phoenix API's naming, not the library's docs. Amazon may require a voice PIN, or the Alexa app, to unlock; any error code is surfaced verbatim with that hint.
- **Garage doors** (`alexa_garage_door`; the account has none): the verified `setModeValue` shape (below) on the device's `GarageDoor.Position` mode instance. The value is the device's own declared mode named "Open…" / "Clos…", else its declared `Position.Up` / `Position.Down`, else those literals. The shape is verified; the garage instance and values are not. Garage instances are refused by `alexa_set_device_mode`, so opening is only ever behind the destructive tool.
- **Alarms**: for `Alarm` the library builds a new-style `{ trigger: { scheduledTime }, extensions, endpointId }` object that `createNotification` POSTs to `/v1/alerts/alarms`. Whether that answer carries `id` like the reminder answer does is unverified.
- **Timers**: the library ignores the time value for `Timer`; the server adds `remainingTime: <duration ms>`.
- **Wall-clock time**: the library computes `originalDate / originalTime` (and an alarm's `scheduledTime`) in the SERVER's zone. The server overwrites them with the wall clock in the device's zone (`preferences.timeZoneId`, which the library loads at init). When that zone is unknown, it uses the literal time from the ISO string, or the server's zone for `inMinutes`. On 2026-10-08 the verified reminder ran with server zone = device zone, so the override was a no-op there.
- **Built-ins**: `sendSequenceCommand(serial, cmd, null)` for `weather, traffic, flashbriefing, goodmorning, funfact, joke, cleanup, singasong, tellstory, calendarToday, calendarTomorrow, calendarNext` (the library ignores the value for these).
- **Fire TV**: `fireTVTurnOn / fireTVTurnOff / fireTVPauseVideo / fireTVResumeVideo / fireTVNavigateHome` sequence commands. The library itself refuses a non-`FIRE_TV` device or one without `deviceAccountId`.
- **Stop**: `deviceStop` (one device) / `deviceStopAll` sequence commands.
- **List item completion**: `updateListItem(listId, itemId, { value, completed, version })`. The library refuses without `value` (the item name, re-sent unchanged) and `version` (re-read first). Note that the library builds that URL as `?version =<n>` (with a space).

## Vacation mode is an emulation

The Alexa app DOES have a native Vacation Mode for these thermostats (Settings → Vacation Mode), but it is not in anything this library reaches: searched 2026-10-08 across `getSmarthomeDevicesV2` (incl. `features`, whose thermostat operations are only `setTargetSetpoint`/`adjustTargetSetpoint`/`setThermostatMode`), `getSmarthomeEntities`, the `phoenix/state` capability states and `getSmarthomeBehaviourActionDefinitions` — no `vacation`/`away`/`hold` anywhere. The app must use a separate thermostat-settings service; reaching it would need a capture of the app's own request. Until then `alexa_set_vacation_mode` emulates it (it does NOT flip the app's Vacation Mode toggle):

1. reads each thermostat's mode and setpoints, and writes them to `<stateDir>/vacation.json` (0600) **before** sending anything;
2. sets AUTO thermostats to the verified dual form, lower = heatTo (55 °F / 13 °C) and upper = coolTo (85 °F / 29 °C), clamped to `allowedTemperatureRange`; HEAT / COOL thermostats keep their mode and get the single-setpoint form (unverified); OFF thermostats are left OFF and not saved;
3. refuses to enable while any target already has a saved entry, so originals are never overwritten;
4. on disable, restores the saved mode (only if it changed) and setpoints, and deletes each entry that was restored. A failed thermostat keeps its entry for a retry.

## Deliberately not used

- `textCommand` (free-text "Alexa, …"): it can make purchases and unlock doors without going through a specific, confirm-gated tool.

## Verified through the built tools (2026-10-08, Upstairs thermostat)

- `alexa_set_thermostat` upper 74 → 75 → 74 (lower 63 untouched), each confirmed by `alexa_get_smart_home_state`.
- `alexa_set_vacation_mode` on (AUTO 63–74° → 55–85°, confirmed by re-read), a second "on" refused, then off (back to 63–74°, confirmed).
- `alexa_get_smart_home_state`, `alexa_get_do_not_disturb`, `alexa_get_equalizer`, `alexa_list_bluetooth` read the live account.
- Lock/unlock and garage doors are now offered through `alexa_lock` / `alexa_garage_door` (destructive, confirm-gated) but are not live-verified: the account has neither.
