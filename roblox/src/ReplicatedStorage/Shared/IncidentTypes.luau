--!strict
-- What an incident is, as data. No behaviour here -- the server reads this and
-- so does the client's dispatch card, so it lives where both can see it.
--
-- TIERS, NOT NPC FILLER. Each kind declares several versions of itself sized to
-- how many people turned up, and the one that runs is chosen when the incident
-- engages. A fire with one responder is a bin fire on the forecourt; with three
-- it is a third-floor flat with a casualty and a cordon.
--
-- This is the whole reason solo play and co-op are the same code path, and it
-- is cheaper than the obvious alternative. NPC filler means pathing, AI and a
-- body to animate for every empty slot; a tier is a different number and a
-- different line of text. It also READS better -- a solo player gets a job
-- sized for one person rather than a job with two robots standing in it.
--
-- WHY NOT JUST SCALE THE TIMER. Because "the same fire but slower on your own"
-- is not a smaller job, it is the same job made worse, and it teaches a new
-- player that being alone is a penalty. A different incident is not a penalty.

export type Slot = {
	role: string,
	max: number,
}

export type Tier = {
	need: number, -- responders this tier wants; the best one that fits is used
	label: string, -- what dispatch calls it
	detail: string, -- the line under it on the card
	work: number, -- seconds of on-scene work at full strength
	pay: number, -- to each responder, on resolution
	radius: number, -- studs you must be within to count as on scene
}

export type Kind = {
	id: string,
	title: string,
	slots: { Slot },
	tiers: { Tier }, -- ordered, smallest first
	life: number, -- seconds before an unclaimed incident expires
	-- COMPETITIVE: claim is not award. A fare or a parcel can be claimed by
	-- everyone on that shift at once and is paid to whoever reaches it FIRST;
	-- the rest get nothing and the job leaves the board. §4.6 asks for this for
	-- taxi and courier specifically, and it is the whole difference between
	-- dispatching a service and taking a job off a rank -- an emergency is
	-- allocated, a fare is raced for.
	competitive: boolean?,
	-- The visual over it. "fire" is the burning building FireFX already builds;
	-- anything else gets the plain beacon.
	marker: string?,
	-- WHAT COLOUR THE JOB IS, and it is one number in one place because it is
	-- read in four: the column over the incident, the blip on the minimap, the
	-- blip on the big map and the card. Three copies of a palette is three
	-- chances for the beacon you drove towards to be a different colour from the
	-- dot you drove towards it from -- which this project has already shipped
	-- once, with the ground palette, and does not intend to ship again.
	colour: Color3,
}

local IncidentTypes: { [string]: Kind } = {

	fire = {
		id = "fire",
		colour = Color3.fromRGB(255, 140, 40),
		title = "STRUCTURE FIRE",
		-- POLICE ARE PART OF THE BIG ONE, not decoration on it. The third tier
		-- says "hold the cordon" and until now there was nobody who could: the
		-- kind declared one role, so three firefighters were the only way to
		-- reach it. A cordon is a police job and this is where the roster starts
		-- to mean something -- two services, three people, one incident.
		slots = { { role = "fire", max = 2 }, { role = "police", max = 1 } },
		marker = "fire",
		life = 240,
		tiers = {
			{
				need = 1,
				label = "Refuse fire",
				detail = "Bin alight against the forecourt wall. One hose point.",
				work = 22,
				pay = 120,
				radius = 90,
			},
			{
				need = 2,
				label = "Flat fire, second floor",
				detail = "Smoke showing. Two crews, one in and one on the main.",
				work = 38,
				pay = 220,
				radius = 90,
			},
			{
				need = 3,
				label = "Flat fire with persons reported",
				detail = "Third floor, one unaccounted. Search, suppress, hold the cordon.",
				work = 52,
				pay = 380,
				radius = 90,
			},
		},
	},

	medical = {
		id = "medical",
		colour = Color3.fromRGB(46, 190, 120),
		title = "MEDICAL CALL",
		slots = { { role = "ambulance", max = 2 }, { role = "police", max = 1 } },
		life = 200,
		tiers = {
			{
				need = 1,
				label = "Collapse in the street",
				detail = "Conscious, breathing. One crew, assess and convey.",
				work = 20,
				pay = 130,
				radius = 70,
			},
			{
				need = 2,
				label = "Cardiac arrest",
				detail = "CPR in progress by a bystander. Two crews, one on the airway.",
				work = 34,
				pay = 230,
				radius = 70,
			},
			{
				need = 3,
				label = "Fall from height",
				detail = "Spinal precautions and a scene that needs holding while you work.",
				work = 46,
				pay = 370,
				radius = 70,
			},
		},
	},

	-- COLLISION-RESPONSE IS THE ONE THAT NEEDS EVERYBODY, and it is the reason
	-- the roster exists rather than a list of separate games. A road traffic
	-- collision is a police scene, an ambulance job and -- once anyone is
	-- trapped -- a fire one, because cutting a car open is the fire service's
	-- work everywhere in Europe. Three services, and the tier that uses all
	-- three is the only tier that pays like it.
	collision = {
		id = "collision",
		colour = Color3.fromRGB(58, 132, 255),
		title = "ROAD COLLISION",
		slots = {
			{ role = "police", max = 2 },
			{ role = "ambulance", max = 1 },
			{ role = "fire", max = 1 },
		},
		life = 220,
		tiers = {
			{
				need = 1,
				label = "Shunt, no injuries",
				detail = "Two cars in the junction and a queue behind them. Clear the road.",
				work = 22,
				pay = 120,
				radius = 80,
			},
			{
				need = 2,
				label = "Collision with injuries",
				detail = "One walking wounded. Scene protection and a crew to treat.",
				work = 36,
				pay = 240,
				radius = 80,
			},
			{
				need = 3,
				label = "Persons trapped",
				detail = "Driver's side caved in. Cut them out, treat, and hold the road.",
				work = 54,
				pay = 400,
				radius = 80,
			},
		},
	},

	-- THE TWO COMPETITIVE ONES. Both are one-person jobs at every tier on
	-- purpose: a fare is not a bigger fare because three cabs turned up, so
	-- there is nothing for a second tier to describe. The tiers ladder is still
	-- here because tierFor needs one, and because a longer job is a real thing
	-- even when the crew size is not.
	fare = {
		id = "fare",
		colour = Color3.fromRGB(242, 183, 5),
		title = "FARE WAITING",
		slots = { { role = "taxi", max = 8 } },
		competitive = true,
		life = 110,
		tiers = {
			{
				need = 1,
				label = "Pickup",
				detail = "Passenger on the pavement with a hand up. First car takes it.",
				work = 3,
				pay = 90,
				radius = 60,
			},
		},
	},

	parcel = {
		id = "parcel",
		colour = Color3.fromRGB(255, 79, 216),
		title = "PARCEL",
		slots = { { role = "courier", max = 8 } },
		competitive = true,
		life = 130,
		tiers = {
			{
				need = 1,
				label = "Collection",
				detail = "Signed for at the door. Whoever gets there is who carries it.",
				work = 3,
				pay = 70,
				radius = 60,
			},
		},
	},
}

-- Whether this kind will take a claim from this role at all -- asked by the
-- dispatch card before it offers you a job, and by the claim path before it
-- takes one. A plain scan of at most three slots.
function IncidentTypes.slotFor(kind: Kind, role: string): Slot?
	for _, s in kind.slots do
		if s.role == role then
			return s
		end
	end
	return nil
end

-- The best tier for a given headcount: the largest one whose `need` is met.
-- Never nil for a headcount of one or more, because every kind declares a
-- one-person tier -- that is a requirement of the design, not an accident, and
-- it is what makes the solo path the same path.
function IncidentTypes.tierFor(kind: Kind, filled: number): (Tier, number)
	local best, index = kind.tiers[1], 1
	for i, t in kind.tiers do
		if t.need <= filled and t.need >= best.need then
			best, index = t, i
		end
	end
	return best, index
end

return IncidentTypes
