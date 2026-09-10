--!strict
-- EVERY STRING A PLAYER READS, BEHIND A KEY -- one language in it so far.
--
-- THE SHAPE IS THE POINT, NOT THE TRANSLATION. Nobody has picked a second
-- language yet, and picking one (which, whose translation, how good) is a
-- product decision this file should not make on its own. What it CAN do
-- without that decision is stop every UI script writing English straight
-- into a `.Text` property, so that when a second language does arrive it is
-- a second table here and a `Loc.locale` switch, not a rewrite of six
-- scripts. `Loc.get` on a key nobody has written a translation for still
-- shows something -- the key itself -- rather than a blank label, so a gap
-- is visible on screen instead of silent.
--
-- WHY NOT `LocalizationService`'s OWN AUTOMATIC TRANSLATION. That is a
-- machine-translated pass over the SOURCE strings by locale, and it wants a
-- game already shipped and generating translation requests to draw on --
-- this is the table it would be translating FROM. Nothing here forecloses
-- wiring `Loc.get` to `LocalizationService:GetTranslatorForPlayerAsync`
-- later; today's `Loc.get` is the identity function over English plus a
-- place to grow a manual table, which is the part that has to exist first.
--
-- KEYS ARE DOTTED PATHS, grouped by who owns the string: `role.*` and
-- `incident.*` are Shared/Roles.luau and Shared/IncidentTypes.luau's own
-- display text (title/short/blurb, and a tier's label/detail); `refuse.*`
-- are the short reasons the two claim/sign-on services hand back over a
-- RemoteFunction when they say no; everything else is one UI script's own
-- prefix. A key with no translation here is not a bug in the UI script that
-- asked for it -- Loc.get's fallback makes that safe -- so new keys get
-- added here as the scripts that need them are written, not invented ahead
-- of use.
--
-- WHAT STAYS OUT, on purpose, and stayed out of every call site this was
-- wired through, not just this file: proper nouns. "VICE MAPS", "PALILULA
-- · BEOGRAD", a depot's real name, a district's name -- these are real-world
-- data or this project's own name, the same reason
-- Shared/Roles.luau/IncidentTypes.luau leave depot names alone, and
-- translating a place name is not localisation, it is a wrong answer about
-- geography. A `%s` format placeholder is how one of these still ends up on
-- screen without this file ever holding it.

local Loc = {}

-- FORMAT STRINGS, NOT TEMPLATES. Every key that takes a value keeps the
-- exact `%d`/`%s`/`%%` a plain `:format()` call already understands, because
-- every call site already had one before this file existed -- wrapping the
-- literal in `Loc.get(...)` and leaving the `:format(...)` where it was is
-- the whole of what most of the wiring is, and it is the lowest-risk
-- transform there is: the arguments and their order do not move.
local EN: { [string]: string } = {

	-- -------------------------------------------------------------- roles

	["role.courier.title"] = "COURIER",
	["role.courier.short"] = "COURIER",
	["role.courier.blurb"] = "Your own car, your own hours. Parcels, point to point.",

	["role.taxi.title"] = "PRIVATE HIRE",
	["role.taxi.short"] = "TAXI",
	["role.taxi.blurb"] = "Fares waiting. First car to the pickup takes it.",

	["role.police.title"] = "POLICE",
	["role.police.short"] = "POLICE",
	["role.police.blurb"] = "Patrol, cordon and response. Signed for at the counter.",

	["role.fire.title"] = "FIRE & RESCUE",
	["role.fire.short"] = "FIRE",
	["role.fire.blurb"] = "Pump, ladder and water. Slow away, first in.",

	["role.ambulance.title"] = "AMBULANCE",
	["role.ambulance.short"] = "MEDICAL",
	["role.ambulance.blurb"] = "A box body on a cab. Casualties, and the drive back.",

	-- ----------------------------------------------------------- incidents

	["incident.fire.title"] = "STRUCTURE FIRE",
	["incident.fire.tier1.label"] = "Refuse fire",
	["incident.fire.tier1.detail"] = "Bin alight against the forecourt wall. One hose point.",
	["incident.fire.tier2.label"] = "Flat fire, second floor",
	["incident.fire.tier2.detail"] = "Smoke showing. Two crews, one in and one on the main.",
	["incident.fire.tier3.label"] = "Flat fire with persons reported",
	["incident.fire.tier3.detail"] = "Third floor, one unaccounted. Search, suppress, hold the cordon.",

	["incident.medical.title"] = "MEDICAL CALL",
	["incident.medical.tier1.label"] = "Collapse in the street",
	["incident.medical.tier1.detail"] = "Conscious, breathing. One crew, assess and convey.",
	["incident.medical.tier2.label"] = "Cardiac arrest",
	["incident.medical.tier2.detail"] = "CPR in progress by a bystander. Two crews, one on the airway.",
	["incident.medical.tier3.label"] = "Fall from height",
	["incident.medical.tier3.detail"] = "Spinal precautions and a scene that needs holding while you work.",

	["incident.collision.title"] = "ROAD COLLISION",
	["incident.collision.tier1.label"] = "Shunt, no injuries",
	["incident.collision.tier1.detail"] = "Two cars in the junction and a queue behind them. Clear the road.",
	["incident.collision.tier2.label"] = "Collision with injuries",
	["incident.collision.tier2.detail"] = "One walking wounded. Scene protection and a crew to treat.",
	["incident.collision.tier3.label"] = "Persons trapped",
	["incident.collision.tier3.detail"] = "Driver's side caved in. Cut them out, treat, and hold the road.",

	["incident.fare.title"] = "FARE WAITING",
	["incident.fare.dropTitle"] = "FARE ABOARD",
	["incident.fare.tier1.label"] = "Pickup",
	["incident.fare.tier1.detail"] = "Passenger on the pavement with a hand up. First car takes it.",
	["incident.fare.tier1.dropLabel"] = "Drop-off",
	["incident.fare.tier1.dropDetail"] = "Gave you an address across town. Get them there.",

	["incident.parcel.title"] = "PARCEL",
	["incident.parcel.dropTitle"] = "PARCEL LOADED",
	["incident.parcel.tier1.label"] = "Collection",
	["incident.parcel.tier1.detail"] = "Signed for at the door. Whoever gets there is who carries it.",
	["incident.parcel.tier1.dropLabel"] = "Delivery",
	["incident.parcel.tier1.dropDetail"] = "Addressed across town. Get it there in one piece.",

	-- ------------------------------------- claim / sign-on refusal reasons

	-- SHORT ON PURPOSE, the same as the English versions were: `say()` and
	-- its RoleUI equivalent hold these on screen for 2.5s next to a card that
	-- is otherwise numbers, and a paragraph would not fit the panel that
	-- shows them.
	["refuse.tooFast"] = "too fast",
	["refuse.noSuchIncident"] = "no such incident",
	["refuse.closed"] = "closed",
	["refuse.noSuchRoleHere"] = "no such role here",
	["refuse.notOnThatShift"] = "not on that shift",
	["refuse.alreadyTaken"] = "already taken",
	["refuse.roleFull"] = "role full",
	["refuse.noSuchShift"] = "no such shift",
	["refuse.noDepotForShift"] = "no depot for that shift in this district",
	["refuse.noVehicle"] = "no vehicle",
	["refuse.notAtDepot"] = "not at a depot",
	["refuse.badRequest"] = "bad request",

	-- -------------------------------------------------------------- dispatch

	["dispatch.kicker"] = "DISPATCH",
	["dispatch.nothingForShift"] = "Nothing for this shift",
	["dispatch.othersOnBoard"] = "%d job%s on the board for other services. Sign on at a depot to take one.",
	["dispatch.onShift"] = "ON  ·  %s",
	["dispatch.crewed"] = "CREWED",
	["dispatch.needs"] = "NEEDS %s",
	["dispatch.onScene"] = "ON SCENE  ·  %s  ·  $%d",
	["dispatch.responding"] = "RESPONDING  ·  %d m  ·  %s",
	["dispatch.takeIt"] = "[E] TAKE IT  ·  %d m  ·  %d racing  ·  $%d",
	["dispatch.respond"] = "[E] RESPOND  ·  %d m  ·  %s  ·  $%d",
	["dispatch.refused"] = "DISPATCH: %s",

	-- ----------------------------------------------------------------- shift

	["roleui.signOn"] = "SIGN ON  ·  %s",
	["roleui.refused"] = "DEPOT: %s",

	-- --------------------------------------------------------------- big map

	["bigmap.locate"] = "ME",
	["bigmap.noImage"] = "Map image unavailable on this client -- markers only",
	["bigmap.hint"] = "%s across  ·  drag to pan  ·  + and - to zoom  ·  %s centres on you  ·  %d jobs  ·  M or X closes",

	-- --------------------------------------------------------------- settings

	["settings.title"] = "SETTINGS",
	["settings.sound"] = "Sound",
	["settings.master"] = "Master",
	["settings.engine"] = "Engine",
	["settings.effects"] = "Crashes and fire",
	["settings.interface"] = "Dispatch tones",
	["settings.controls"] = "Controls",
	["settings.revSteer"] = "Reverse steering",
	["settings.revSteer.stick"] = "STICK",
	["settings.revSteer.car"] = "CAR",
	["settings.footer"] = "O to open",

	-- --------------------------------------------------------------- wanted

	-- REFRAMED FROM js/game.js's WASTED/BUSTED, not renamed for its own sake:
	-- the plan this was built against reads nobody as having died, and "down"
	-- says that plainly rather than importing a word the plan explicitly
	-- ruled out. "Pulled over" is what a bust actually is, described rather
	-- than announced.
	["wanted.down.title"] = "DOWN",
	["wanted.down.sub"] = "cleaned out · coming round at the hospital",
	["wanted.busted.title"] = "PULLED OVER",
	["wanted.busted.sub"] = "−$%d · booked at the station",
}

-- Which table Loc.get reads. One value today; the second half of this file
-- becoming real is this switching on something -- a settings choice, or
-- `LocalizationService:GetTranslatorForPlayerAsync` -- and EN staying as the
-- fallback every other table is missing a key from.
Loc.locale = "en"

-- THE KEY ITSELF ON A MISS, not "" and not an error. A UI script that asks
-- for a key nobody has written English for yet still gets something legible
-- on screen -- the key, which is a very findable bug -- rather than an empty
-- label that looks like the widget itself is broken, or a thrown error that
-- takes the whole script down the way a much smaller mistake already has
-- more than once in this project (see Shared/Audio.luau's own account of
-- that).
function Loc.get(key: string): string
	return EN[key] or key
end

return Loc
