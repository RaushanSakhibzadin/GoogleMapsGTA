--!strict
-- ONE CLIENT SCRIPT TELLING ANOTHER SOMETHING.
--
-- A ModuleScript is required once per client and its table is shared by every
-- script on that client, so a BindableEvent made in here is a signal any of
-- them can fire and any of them can listen to. Same mechanism as
-- Shared/PlayerCar, for the same reason: no copy, no round trip, no remote.
--
-- IT IS NOT A REMOTE AND MUST NOT BECOME ONE. Nothing here crosses the network
-- and nothing here is authoritative -- it is the minimap telling the big map
-- that somebody tapped it. Anything the server needs to believe goes through
-- ReplicatedStorage.Remotes and is validated there.

local ClientBus = {}

-- Tapping the minimap, or the map hotkey. Fired by Minimap, heard by BigMap.
-- They are separate scripts because they are separate screens: one runs every
-- frame at 20 Hz forever, the other is idle until it is opened.
ClientBus.toggleMap = Instance.new("BindableEvent")

-- THE SHIFT, and the district's depots, held rather than only signalled.
--
-- RoleState arrives once at join, and three scripts need it: the sign-on prompt,
-- the dispatch card (which jobs may I take?) and both maps (where are the
-- depots?). A BindableEvent alone would only reach whoever happened to be
-- listening at the moment the message landed, and on a client where every
-- script is still doing WaitForChild that is a coin toss. So the value is KEPT
-- here and the event says it changed -- a late listener reads the field, an
-- early one hears the event, and neither has to know which it was.
ClientBus.role = "courier"
ClientBus.playable = {} :: { string }
ClientBus.depots = {} :: { { kind: string, role: string, x: number, z: number, gx: number?, gz: number?, name: string } }
ClientBus.roleChanged = Instance.new("BindableEvent")

-- ON A SHOUT. True while you hold a slot on an incident and are not there yet,
-- which is exactly when a blue light is on and a siren is running. Written by
-- DispatchUI, which is the only script that knows; read by RoleUI to flash the
-- beacon. A plain field rather than an event because it is read every frame and
-- there is nothing to react to -- only a value to look at.
ClientBus.responding = false

-- WHERE THE THING YOU ARE RESPONDING TO IS, in world studs -- nil whenever
-- `responding` is false. Written alongside it by DispatchUI for the same
-- reason: the screen-edge objective arrow (Minimap.client.luau) needs a
-- position to point at and has no other way to ask what the dispatch card
-- already knows.
ClientBus.myIncident = nil :: { x: number, z: number }?

-- REVERSE STEERING, the same preference js/entities.js's own REV_REAL is.
-- False takes the stick literally -- back-and-left reverses to the left --
-- which is the default in both games. Read every frame by
-- VehicleController, written by SettingsUI the moment the panel's toggle
-- changes and again once the persisted value comes back from the server on
-- join -- a plain field for the same reason `responding` above is one: there
-- is nothing to react to, only a value to look at whenever the car next
-- reverses.
ClientBus.revSteer = false

-- DOWN, the same idea as js/game.js's P.dead: true for the 2.2 s hold between
-- going down (Services/WantedService.luau's beginDown, on a bust or on
-- running out of hp) and waking up wherever the server sent the car.
-- VehicleController reads it to feed the drive model a zeroed input the same
-- way js/game.js's own update() does (`P.dead ? {...zero} : readInput()`) --
-- a car should not answer the wheel while its driver is being carried in,
-- and the server is about to move it out from under whatever the player was
-- doing anyway. Written by WantedUI, which is the one script that hears
-- Remotes.WantedState.
ClientBus.down = false

return ClientBus
