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
}

local IncidentTypes: { [string]: Kind } = {

	fire = {
		id = "fire",
		title = "STRUCTURE FIRE",
		slots = { { role = "fire", max = 3 } },
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
}

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
