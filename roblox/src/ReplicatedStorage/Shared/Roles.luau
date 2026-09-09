--!strict
-- THE FIVE SHIFTS, as data. No behaviour: the server reads this to decide who
-- may sign on where and what they may claim, the client reads it to draw the
-- depot prompt and the role chip, and CarBuild reads it to dress the car.
--
-- title/short/blurb ARE Shared/Loc.luau KEYS, not the English text itself --
-- this file stays data-and-nothing-else the same way it always has, so the
-- one place that turns a key into words on screen is Loc.get, called by
-- whichever client script is about to set a `.Text`.
--
-- PORTED FROM js/game.js:1123 JOBS, which is the design already play-tested,
-- and the notes there are the reasons for the numbers here:
--
--   · THE CAR LOOKS LIKE THE JOB. Paint alone was never going to carry it -- a
--     white car is an ambulance, a police car and half the traffic. So a shift
--     changes the BODY as well: an appliance is 7.4 m long and 2.7 m tall, an
--     ambulance is a 6 m box on a cab, and both are built out of the same boxes
--     the hatchback is, which is why five vehicles cost no modelling at all.
--   · THE APPLIANCE GOES WHERE THE FIRE IS. A fire is a building, not a street,
--     and the last thirty metres to one are a forecourt. Without `offroad` the
--     end of every call was a walk -- reported from play in the browser, twice.
--   · THE ARMOURED CAR is the half of "police vehicle" that is not paint.
--
-- WHERE A SHIFT IS SIGNED ON, and why `depot` is a LIST.
--
-- Counted on the bundled Belgrade capture rather than assumed -- 10,907 tagged
-- elements inside the 2.4 km district:
--
--     amenity=police        2      amenity=hospital     0
--     amenity=fire_station  1      amenity=taxi         0
--     amenity=clinic       12      amenity=fuel         5
--
-- Belgrade has NO amenity=hospital and NO amenity=taxi anywhere in the capture:
-- its hospitals are tagged as clinics and institutes, because that is what a
-- дом здравља is and OSM reserves amenity=hospital for something narrower. So
-- two of these five shifts had nowhere to start -- in this game AND in the
-- browser one, where the ambulance shift has been unreachable in the offline
-- city the whole time.
--
-- The fallback is SECOND in the list and never first, so a district that has
-- the textbook depot still sends you to the textbook depot. A role whose whole
-- list is missing is reported at boot and cannot be signed on, which is the
-- truth rather than a button that does nothing.

export type Body = {
	l: number, -- metres, nose to tail
	w: number,
	h: number,
}

export type Role = {
	id: string,
	title: string, -- Shared/Loc.luau KEY for what the chip says
	short: string, -- Shared/Loc.luau KEY for what the dispatch card says
	blurb: string, -- Shared/Loc.luau KEY for the line under the sign-on prompt
	depot: { string }, -- OSM depot kinds, best first; empty means anywhere
	colour: Color3?, -- nil keeps the player's own paint (courier drives their car)
	livery: string, -- "none" | "police" | "fire" | "ambulance" | "taxi"
	beacon: Color3?, -- roof light, nil for none
	body: Body?, -- nil is the stock hatchback
	speed: number, -- multiplier on top speed
	accel: number, -- multiplier on acceleration
	offroad: boolean, -- ignores the off-tarmac speed penalty
	armour: number, -- damage taken, multiplier
}

local Roles = {}

-- The order the sign-on prompt and the settings list use. Courier first because
-- it is where everyone starts and where signing off returns you to.
Roles.ORDER = { "courier", "taxi", "police", "fire", "ambulance" }

Roles.DEFAULT = "courier"

local BY_ID: { [string]: Role } = {

	-- NO DEPOT, ON PURPOSE. `at: null` in the browser: a courier is the shift you
	-- are on when you are not on a shift, and gating it would leave a new player
	-- with nothing to do until they had found a building. It is also the way OUT
	-- of every other shift -- standing at the depot you already work for offers
	-- this instead, or the button is one that does nothing where you are most
	-- likely to press it.
	courier = {
		id = "courier",
		title = "role.courier.title",
		short = "role.courier.short",
		blurb = "role.courier.blurb",
		depot = {},
		colour = nil,
		livery = "none",
		beacon = nil,
		body = nil,
		speed = 1,
		accel = 1,
		offroad = false,
		armour = 1,
	},

	taxi = {
		id = "taxi",
		title = "role.taxi.title",
		short = "role.taxi.short",
		blurb = "role.taxi.blurb",
		depot = { "taxi", "fuel" },
		colour = Color3.fromRGB(242, 183, 5),
		livery = "taxi",
		beacon = nil,
		body = nil,
		speed = 1,
		accel = 1,
		offroad = false,
		armour = 1,
	},

	police = {
		id = "police",
		title = "role.police.title",
		short = "role.police.short",
		blurb = "role.police.blurb",
		depot = { "police" },
		colour = Color3.fromRGB(238, 241, 246),
		livery = "police",
		beacon = Color3.fromRGB(58, 132, 255),
		body = nil,
		-- A response car is the quick one. Modest, because a police shift that is
		-- also the fastest car in the game is a police shift everyone takes for
		-- the car rather than the work.
		speed = 1.08,
		accel = 1.12,
		offroad = false,
		armour = 0.45,
	},

	fire = {
		id = "fire",
		title = "role.fire.title",
		short = "role.fire.short",
		blurb = "role.fire.blurb",
		depot = { "fire" },
		colour = Color3.fromRGB(224, 48, 31),
		livery = "fire",
		beacon = Color3.fromRGB(255, 64, 40),
		-- The appliance, at the browser's dimensions.
		body = { l = 7.4, w = 2.5, h = 2.7 },
		-- Fourteen tonnes of pump and water does not accelerate. This is what
		-- `mass: 8` buys in the browser, expressed in the two numbers this port's
		-- vehicle model actually has.
		speed = 0.86,
		accel = 0.62,
		offroad = true,
		armour = 1,
	},

	ambulance = {
		id = "ambulance",
		title = "role.ambulance.title",
		short = "role.ambulance.short",
		blurb = "role.ambulance.blurb",
		depot = { "hospital", "clinic" },
		colour = Color3.fromRGB(244, 246, 250),
		livery = "ambulance",
		beacon = Color3.fromRGB(58, 132, 255),
		body = { l = 6.0, w = 2.25, h = 2.55 },
		speed = 0.95,
		accel = 0.82,
		-- A van reaches the door of a building the same way an appliance does.
		offroad = true,
		armour = 1,
	},
}

function Roles.get(id: string?): Role
	return BY_ID[id or ""] or BY_ID[Roles.DEFAULT]
end

function Roles.exists(id: string): boolean
	return BY_ID[id] ~= nil
end

-- WHICH DEPOT KIND ACTUALLY BACKS A ROLE, given the kinds a district has. Nil
-- means the role cannot be signed on here at all; "" means it needs no depot.
--
-- `have` is a set of depot kinds, so this is a handful of table lookups and can
-- be called from anywhere, including the claim path.
function Roles.depotKind(role: Role, have: { [string]: boolean }): string?
	if #role.depot == 0 then
		return ""
	end
	for _, kind in role.depot do
		if have[kind] then
			return kind
		end
	end
	return nil
end

return Roles
