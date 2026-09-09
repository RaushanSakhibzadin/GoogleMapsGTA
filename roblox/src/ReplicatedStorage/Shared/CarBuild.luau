--!strict
-- A CAR, built out of boxes to match the city it drives in.
--
-- Deliberately crude, and it is the same decision the browser game made for the
-- same reason: js/carmesh.js builds every vehicle out of the car's own eight
-- corners, which is how a fire appliance and an ambulance become different
-- vehicles without anybody modelling one. A voxel city wants a voxel car, and a
-- box with a cabin on it reads as a car from the only distance you ever see it.
--
-- Sized in METRES and converted here, from the same CityMeta.studsPerMetre the
-- city was emitted with -- so a change of scale moves the car and the buildings
-- together instead of leaving one of them wrong.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local S = Meta.studsPerMetre

local CarBuild = {}

-- metres: a hatchback, matching makeCar's defaults in js/entities.js
CarBuild.LENGTH = 4.5
CarBuild.WIDTH = 2.0
CarBuild.HEIGHT = 1.45

local function box(name: string, sx: number, sy: number, sz: number, colour: Color3): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.CanCollide = false -- the car is kinematic; see VehicleController
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.Material = Enum.Material.SmoothPlastic
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Size = Vector3.new(sx, sy, sz)
	p.Color = colour
	return p
end

-- A WedgePart's slope runs flat-bottomed, full Size.Y tall at local +Z, down
-- to a zero-height edge at local -Z -- confirmed empirically (a test wedge,
-- screenshotted) rather than assumed, since getting this backwards mirrors
-- the taper into a ramp up to the bumper instead of a nose down to it.
local function wedge(name: string, sx: number, sy: number, sz: number, colour: Color3): WedgePart
	local p = Instance.new("WedgePart")
	p.Name = name
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.Material = Enum.Material.SmoothPlastic
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Size = Vector3.new(sx, sy, sz)
	p.Color = colour
	return p
end

-- THE MARKINGS, shared between the player's own car (dress, below) and every
-- NPC service vehicle (npc, further down) -- a police car reads as a police
-- car whether it is yours or the one three cars ahead of you, and building
-- this twice would be two places for a chequer band to drift out of step.
--
-- Takes the hull's own geometry rather than re-deriving it, because dress()
-- and npc() arrive at the same numbers by slightly different routes (a
-- resized shared hull vs. three fresh boxes) and this has no reason to care
-- which.
local function markings(
	model: Model,
	W: number,
	H: number,
	L: number,
	hullH: number,
	cabinH: number,
	cabinY: number,
	boxy: boolean,
	livery: string,
	beacon: Color3?
)
	-- A BAND ALONG THE FLANK is what every service vehicle on a European street
	-- actually wears, and it is the cheapest marking that survives being seen
	-- from a chase camera: two thin parts, one a side, at the hull's waist.
	local function flank(name: string, bandColour: Color3, y: number, thick: number, len: number)
		for _, side in { -1, 1 } do
			local p = box(name, W * 0.06, hullH * thick, L * len, bandColour)
			p.CFrame = CFrame.new(side * W * 0.5, y, 0)
			p.Parent = model
		end
	end

	if livery == "police" then
		-- The chequer, reduced to what reads: a dark band with pale blocks in it.
		flank("Band", Color3.fromRGB(30, 44, 96), 0, 0.34, 0.92)
		for i = -2, 2 do
			for _, side in { -1, 1 } do
				local p = box("Check", W * 0.07, hullH * 0.34, L * 0.09, Color3.fromRGB(236, 240, 248))
				p.CFrame = CFrame.new(side * W * 0.5, 0, i * L * 0.18)
				p.Parent = model
			end
		end
	elseif livery == "fire" then
		flank("Band", Color3.fromRGB(255, 236, 180), hullH * 0.1, 0.2, 0.94)

		-- THE LADDER, stowed along the roof -- ported from js/render3d.js's
		-- pushFireEngine rather than guessed at. Two rails and nine rungs is
		-- what the browser game draws and its own comment says why: rungs are
		-- what make two rails read as a ladder instead of a pair of pipes,
		-- and at this size they are the cheapest recognisable thing on the
		-- whole vehicle.
		--
		-- pushFireEngine places everything in the vehicle's own normalised
		-- box (front/lateral/up each -1..1 across the body), which is not
		-- this file's coordinate system -- so f (front-positive) carries to
		-- this file's z (nose-negative) and l (lateral, ±1 = the flank) to
		-- x, both scaled by half the relevant dimension, the same way the
		-- taper above carries CAR_STATIONS onto this hull.
		--
		-- HEIGHT DOES NOT CARRY THE SAME WAY. js/render3d.js draws its
		-- ladder (u = .76-.86) just clear of a separate, shorter BODY box
		-- that tops out at .74, with the cab a taller box beside it, not
		-- under it. This file has no such second box for a van shape --
		-- boxy's "cabin" IS the whole raised superstructure, running
		-- nearly the full length at nearly the full height, which is
		-- exactly where the ladder needs to sit. Carrying the JS u
		-- fraction straight across put the ladder inside that box,
		-- invisible -- caught on a screenshot, not guessed at. So the
		-- ladder is pinned above the cabin's OWN roof instead, which is
		-- where "stowed on the roof" actually lands once there is only
		-- one box to put a roof on.
		local function lX(l0: number, l1: number): (number, number)
			return (l0 + l1) * 0.25 * W, (l1 - l0) * 0.5 * W
		end
		local function fZ(f0: number, f1: number): (number, number)
			return -(f0 + f1) * 0.25 * L, (f1 - f0) * 0.5 * L
		end
		local roofY = cabinY + cabinH * 0.5
		-- Thicknesses kept as JS had them: a rung is .06 of a u-range 2.0
		-- wide against a rail's .10, i.e. six tenths as thick, and both
		-- read here as the same fraction of this file's own H.
		local railY, railH = roofY + H * 0.04, H * 0.05
		local rungY, rungH = roofY + H * 0.04, H * 0.03

		-- rail colour, near enough to aluminium -- FIRE_LADDER in the original
		local ladderColour = Color3.fromRGB(201, 209, 217)
		for _, side in { -1, 1 } do
			local c0 = side * 0.40
			local cx, sx = lX(c0 - 0.06, c0 + 0.06)
			local cz, sz = fZ(-0.98, 0.30)
			local rail = box("LadderRail", sx, railH, sz, ladderColour)
			rail.CFrame = CFrame.new(cx, railY, cz)
			rail.Parent = model
		end
		for i = 0, 8 do
			local f0 = -0.94 + i * 0.145
			local cx, sx = lX(-0.40, 0.40)
			local cz, sz = fZ(f0, f0 + 0.05)
			local rung = box("LadderRung", sx, rungH, sz, ladderColour)
			rung.CFrame = CFrame.new(cx, rungY, cz)
			rung.Parent = model
		end
	elseif livery == "ambulance" then
		flank("Band", Color3.fromRGB(46, 190, 120), 0, 0.3, 0.94)
		-- The cross, on the flank rather than the roof: the roof is the one
		-- surface a chase camera never shows you.
		for _, side in { -1, 1 } do
			local a = box("Cross", W * 0.07, hullH * 0.5, L * 0.055, Color3.fromRGB(240, 246, 250))
			a.CFrame = CFrame.new(side * W * 0.5, 0, -L * 0.26)
			a.Parent = model
			local b = box("Cross", W * 0.07, hullH * 0.18, L * 0.16, Color3.fromRGB(240, 246, 250))
			b.CFrame = CFrame.new(side * W * 0.5, 0, -L * 0.26)
			b.Parent = model
		end
	elseif livery == "taxi" then
		-- The chequer again, in the one place a taxi wears it, plus the sign that
		-- is the actual silhouette of a private-hire car.
		flank("Band", Color3.fromRGB(24, 24, 28), 0, 0.26, 0.9)
		for i = -2, 2 do
			for _, side in { -1, 1 } do
				local p = box("Check", W * 0.07, hullH * 0.26, L * 0.09, Color3.fromRGB(246, 226, 120))
				p.CFrame = CFrame.new(side * W * 0.5, 0, i * L * 0.18)
				p.Parent = model
			end
		end
		local sign = box("Sign", W * 0.34, H * 0.14, L * 0.1, Color3.fromRGB(28, 28, 32))
		sign.CFrame = CFrame.new(0, cabinY + cabinH * 0.5 + H * 0.07, L * 0.02)
		sign.Parent = model
	end

	-- TWO LAMPS, NOT ONE. js/render3d.js's pushPolice, pushFireBar and
	-- pushAmbulanceBar are the same function under three names: a fixed blue
	-- lamp on one side of the bar, a fixed red lamp on the other, and BOTH
	-- strobe on the same clock -- nothing there actually swaps which one is
	-- lit; the two of them brighten together and dim together, and it is the
	-- two colours sitting side by side that read as a flashing bar rather
	-- than any left/right alternation. One box in one colour read as "this
	-- car's beacon is blue," which is what was reported, and the role's own
	-- colour (still `beacon`, still used for a dispatch marker elsewhere) has
	-- no more to do with the bar's paint here than it does in the browser
	-- game -- it now only says whether this vehicle gets a bar at all.
	--
	-- Dark at rest, animated by whoever owns the car rather than here: this
	-- module builds, it does not run.
	if beacon then
		local barY = cabinY + cabinH * 0.5 + H * 0.045
		local barZ = L * (if boxy then -0.24 else 0.02)

		local base = box("BeaconBase", W * 0.42, H * 0.03, L * 0.09, Color3.fromRGB(18, 20, 24))
		base.CFrame = CFrame.new(0, barY - H * 0.03, barZ)
		base.Parent = model

		local function lampAt(name: string, lampColour: Color3, x: number)
			local p = box(name, W * 0.2, H * 0.05, L * 0.08, lampColour)
			p.Material = Enum.Material.Neon
			p.Transparency = 0.55
			p.CFrame = CFrame.new(x, barY, barZ)
			p.Parent = model

			local light = Instance.new("PointLight")
			light.Color = lampColour
			light.Range = 26
			light.Brightness = 0
			light.Shadows = false
			light.Parent = p
		end
		lampAt("BeaconL", Color3.fromRGB(77, 158, 255), -W * 0.14)
		lampAt("BeaconR", Color3.fromRGB(255, 56, 46), W * 0.14)
	end
end

-- THE TAPER, ported from js/carmesh.js's CAR_STATIONS -- a hatchback's roof
-- rises to its full height over the cabin and drops away at both ends, low
-- at the bonnet and lower still at the tailgate, which a flat-ended box has
-- never had any of. Extends the silhouette forward and back from the hull's
-- own flat ends rather than replacing them, so hullH/cabinY/wheel-drop/
-- markings -- everything already measured off the hull -- stay exactly what
-- they were; only two more parts appear, outside the hull's own footprint.
--
-- A VAN DOES NOT GET ONE. js/render3d.js draws the appliance and the box
-- body as their own flat-fronted shapes, never through carMeshBuild at all
-- -- boxy is already this file's own name for that distinction (CarBuild.dress
-- and CarBuild.npc both compute it the same way) and this reads it rather
-- than adding a second one.
--
-- Returns how far the nose and tail extend past the hull, in studs, which is
-- the only thing a caller with its own lamps (CarBuild.dress) needs back --
-- CarBuild.npc has none to move.
local function taper(
	model: Model,
	colour: Color3,
	W: number,
	L: number,
	hullH: number,
	cabinH: number,
	cabinY: number,
	boxy: boolean
): (number, number)
	if boxy then
		return 0, 0
	end
	-- Asymmetric, the way a real bonnet and a real tailgate are: the front
	-- overhang is the longer of the two in js/carmesh.js's own station table.
	local noseLen = L * 0.16
	local tailLen = L * 0.10
	-- Ground to the greenhouse's own peak -- the full height a real bonnet
	-- and tailgate taper down FROM, not just the lower hull's.
	local peakY = cabinY + cabinH * 0.5
	local baseY = -hullH * 0.5
	local taperH = peakY - baseY
	local taperCY = (peakY + baseY) * 0.5

	local nose = wedge("Nose", W * 0.94, taperH, noseLen, colour)
	nose.CFrame = CFrame.new(0, taperCY, -L * 0.5 - noseLen * 0.5)
	nose.Parent = model

	-- Tall end at +Z is wrong here -- the tail's tall end has to face the
	-- hull, which is -Z from the tail wedge's own centre -- so this is the
	-- one of the two that needs the turn.
	local tail = wedge("Tail", W * 0.94, taperH, tailLen, colour)
	tail.CFrame = CFrame.new(0, taperCY, L * 0.5 + tailLen * 0.5) * CFrame.Angles(0, math.pi, 0)
	tail.Parent = model

	return noseLen, tailLen
end

-- The model's PrimaryPart sits at the car's centre, at ground level plus half
-- the body height, with -Z along the car's nose. Everything else is welded to
-- it by offset, so the whole car moves with one PivotTo.
function CarBuild.new(colour: Color3): Model
	local model = Instance.new("Model")
	model.Name = "Car"

	-- THE HULL IS MADE HERE AND NEVER REMADE, which is the one thing dress()
	-- below is not allowed to touch. It is the model's PrimaryPart, it is what
	-- the server points a player's ReplicationFocus at, and it is what every
	-- client that has already found this car is holding a reference to. Changing
	-- shift resizes it; destroying it would silently break all three.
	local body = box("Body", 1, 1, 1, colour)
	body.CFrame = CFrame.new()
	body.Parent = model
	model.PrimaryPart = body

	CarBuild.dress(model, colour, nil, "none", nil)
	return model
end

-- ---------------------------------------------------------------- the shift

-- REBUILD THE CAR AS THE VEHICLE THE SHIFT DRIVES, in place.
--
-- Everything except the hull is decoration, so everything except the hull is
-- thrown away and made again at the new dimensions. That is a dozen parts once,
-- at a depot, on a deliberate act -- against the alternative, which is a table
-- of per-part offsets that has to stay in step with five body shapes.
--
-- `body` is metres or nil for the stock hatchback; `livery` is what is painted
-- ON the paint, and it is the half of "looks like the job" that colour cannot
-- do -- a white car is an ambulance, a police car and half the traffic.
function CarBuild.dress(model: Model, colour: Color3, body: { l: number, w: number, h: number }?, livery: string, beacon: Color3?)
	local hull = model.PrimaryPart
	if not hull then
		return
	end

	local lM = if body then body.l else CarBuild.LENGTH
	local wM = if body then body.w else CarBuild.WIDTH
	local hM = if body then body.h else CarBuild.HEIGHT
	local L, W, H = lM * S, wM * S, hM * S

	-- A van and an appliance are a cabin that runs nearly the whole length and
	-- sits square on the hull; a car is a cabin set back from the nose. Same
	-- decision, and the same word for it, as CarBuild.npc.
	local boxy = hM > 2.2

	for _, d in model:GetChildren() do
		if d ~= hull then
			d:Destroy()
		end
	end

	local hullH = H * (if boxy then 0.45 else 0.62)
	hull.Size = Vector3.new(W, hullH, L)
	hull.Color = colour

	local cabinH = H * (if boxy then 0.55 else 0.5)
	local cabin = box(
		"Cabin",
		W * (if boxy then 0.96 else 0.86),
		cabinH,
		L * (if boxy then 0.7 else 0.46),
		colour:Lerp(Color3.new(0, 0, 0), 0.18)
	)
	cabin.Parent = model

	local glass = box(
		"Glass",
		W * (if boxy then 0.98 else 0.88),
		H * (if boxy then 0.22 else 0.3),
		L * (if boxy then 0.66 else 0.44),
		Color3.fromRGB(60, 74, 88)
	)
	glass.Parent = model

	local wheelColour = Color3.fromRGB(28, 28, 32)
	for i, off in
		{
			Vector3.new(1, 0, 1),
			Vector3.new(-1, 0, 1),
			Vector3.new(1, 0, -1),
			Vector3.new(-1, 0, -1),
		}
	do
		local w = box("Wheel" .. i, W * 0.16, H * 0.34, L * 0.19, wheelColour)
		w.CFrame = CFrame.new(off.X * W * 0.46, -hullH * 0.5 - H * 0.02, off.Z * L * 0.32)
		w.Parent = model
	end

	-- WHICH END IS THE FRONT.
	--
	-- Reported as "it is hard to understand which side of the car is which",
	-- and on a plain coloured box it genuinely is -- particularly once the
	-- camera swings round the front when you reverse, at which point there is
	-- nothing on screen that says which way the car is pointing.
	--
	-- So the car gets the two things that tell you at a glance in any real
	-- traffic: pale lamps at the front and red ones at the back. Neon, because
	-- they have to read at a distance and in shadow, and small, because the
	-- point is orientation rather than decoration. The cabin is also set back
	-- rather than centred, which gives the silhouette a bonnet.
	local function lamp(name: string, lampColour: Color3, x: number, z: number)
		local p = box(name, W * 0.2, H * 0.16, L * 0.05, lampColour)
		p.Material = Enum.Material.Neon
		p.CFrame = CFrame.new(x, hullH * 0.1, z)
		p.Parent = model
	end
	-- POSITIONED ONCE, HERE, relative to the hull sitting at the origin. PivotTo
	-- moves a model's parts together and preserves what they are relative to
	-- each other, so laying the car out once at build time is all it needs -- an
	-- earlier version carried a table of per-part offsets and reapplied them
	-- every frame, which is work PivotTo was already doing.
	local cabinY = (hullH + cabinH) * 0.5 - H * 0.06
	-- Set BACK from centre, so the bonnet is longer than the boot and the shape
	-- itself says which way it faces even with the lamps off screen.
	cabin.CFrame = CFrame.new(0, cabinY, L * (if boxy then 0.08 else 0.1))
	glass.CFrame = CFrame.new(0, cabinY + cabinH * 0.12, L * (if boxy then 0.04 else 0.06))

	-- BEFORE THE LAMPS, so a tapered nose or tail can push where "the very
	-- front" actually is -- the lamps have to sit on the real tip, not on
	-- the hull's own flat end the taper now sits proud of.
	local noseExt, tailExt = taper(model, colour, W, L, hullH, cabinH, cabinY, boxy)

	local nose = -L * 0.5 - noseExt
	local tail = L * 0.5 + tailExt
	lamp("HeadL", Color3.fromRGB(255, 246, 214), -W * 0.3, nose)
	lamp("HeadR", Color3.fromRGB(255, 246, 214), W * 0.3, nose)
	lamp("TailL", Color3.fromRGB(226, 46, 42), -W * 0.3, tail)
	lamp("TailR", Color3.fromRGB(226, 46, 42), W * 0.3, tail)

	markings(model, W, H, L, hullH, cabinH, cabinY, boxy, livery, beacon)

	-- WHERE THE PIVOT WANTS TO BE, so a caller that did not build the car does
	-- not have to re-derive a hull height it was never told. It CHANGES with the
	-- shift, which is why it is an attribute rather than a constant.
	--
	-- DERIVED FROM THE WHEELS rather than from the body, and the difference only
	-- shows up now that a body can be something other than a hatchback. The old
	-- value was H * 0.5, which is exactly this formula for the stock car -- half
	-- the hull is H * 0.31 and the wheel drop is H * 0.19, and they sum to the
	-- half height it was written as. For the appliance they do not: a boxy hull
	-- is 0.45 of the height rather than 0.62, so H * 0.5 stands it two thirds of
	-- a stud off the road. Same number as before for every car that existed
	-- yesterday, and the right number for the two that did not.
	model:SetAttribute("BodyY", hullH * 0.5 + H * 0.19)
	model:SetAttribute("Livery", livery)
end

-- ---------------------------------------------------------------- traffic

-- THE SAME CAR WITH THE DETAIL TAKEN OFF, for the seventy-odd vehicles that are
-- not yours.
--
-- Three parts instead of eleven, and the reason is what has to happen to them
-- every frame rather than how many of them there are: a PivotTo moves every
-- part in the model, so eleven parts a car at this count is eight hundred and
-- fifty parts being written sixty times a second to draw wheels nobody can see
-- from a chase camera. The hull, the cabin and a glass band are what reads as a
-- car at the only distance you ever see one of these from.
--
-- AND THE DIMENSIONS ARE THE VEHICLE. A bus is this function with l = 10.4 and
-- a cabin that runs nearly the whole length; a fire appliance is the same boxes
-- again. That is exactly what js/carmesh.js does -- every vehicle in the
-- browser game is the car's own eight corners with different numbers in them --
-- and it is why a fleet of five service vehicles costs no modelling at all.
--
-- Sized in METRES; the studs conversion happens here, once, at build time.
--
-- `livery` and `beacon` dress a service vehicle exactly as CarBuild.dress does
-- for the player's own car -- a fire engine three cars ahead of you should
-- look like a fire engine, not a red box. `beacon` is nil for kinds with no
-- lightbar (lorry, bus): pass Roles.get(livery).beacon at the call site,
-- since a livery string and a role id are the same word for these five.
function CarBuild.npc(
	colour: Color3,
	lengthM: number,
	widthM: number,
	heightM: number,
	boxy: boolean,
	livery: string?,
	beacon: Color3?
): Model
	local L, W, H = lengthM * S, widthM * S, heightM * S

	local model = Instance.new("Model")
	model.Name = "Traffic"

	-- THE HULL SITS AT THE MODEL'S ORIGIN and everything else is measured from
	-- it, because PivotTo moves a model by its PrimaryPart: give the hull an
	-- offset of its own and every place() lands the car that far off the road.
	local hullH = H * (if boxy then 0.45 else 0.62)
	local hull = box("Body", W, hullH, L, colour)
	hull.CFrame = CFrame.new()
	hull.Parent = model
	model.PrimaryPart = hull

	-- A van body is a cabin that runs nearly the whole length and sits square on
	-- the hull; a car is a cabin set back from the nose, which is what gives the
	-- silhouette a bonnet and says which way it faces.
	local cabinH = H * (if boxy then 0.55 else 0.5)
	local cabinY = (hullH + cabinH) * 0.5 - H * 0.06
	local cabin = box(
		"Cabin",
		W * (if boxy then 0.98 else 0.86),
		cabinH,
		L * (if boxy then 0.82 else 0.46),
		colour:Lerp(Color3.new(0, 0, 0), 0.14)
	)
	cabin.CFrame = CFrame.new(0, cabinY, L * (if boxy then 0.06 else 0.1))
	cabin.Parent = model

	-- One dark band where the windows are. It is what makes a coloured box read
	-- as a vehicle rather than as a crate, and at three parts a car it is worth
	-- more than the wheels would be.
	local glass = box(
		"Glass",
		W * (if boxy then 1.0 else 0.88),
		H * 0.22,
		L * (if boxy then 0.8 else 0.44),
		Color3.fromRGB(52, 64, 78)
	)
	glass.CFrame = CFrame.new(0, hullH * 0.5 + cabinH * 0.62, L * (if boxy then 0.02 else 0.06))
	glass.Parent = model

	taper(model, colour, W, L, hullH, cabinH, cabinY, boxy)

	if livery then
		markings(model, W, H, L, hullH, cabinH, cabinY, boxy, livery, beacon)
	end

	-- WHERE THE PIVOT WANTS TO BE, so the caller does not have to re-derive the
	-- hull height it was never told. Half the hull, which stands the vehicle on
	-- the road rather than in it.
	model:SetAttribute("BodyY", hullH * 0.5)
	model:SetAttribute("Livery", livery)
	return model
end

-- Put the whole car at a world position and heading.
--
-- x and y are METRES in the browser game's world (+x east, +y south) and h is
-- its heading, 0 = east. Roblox gets x -> X, y -> Z, and the heading becomes a
-- rotation about Y. The sign is the fiddly part: the model's nose is -Z, and
-- world heading 0 must point along +X, so the yaw is -(h) - pi/2... which is
-- what the CFrame.Angles below works out to. Getting this wrong mirrors the car
-- and it is invisible until you try to drive down a street.
function CarBuild.place(model: Model, x: number, y: number, h: number, bodyY: number?)
	local body = model.PrimaryPart
	if not body then
		return
	end
	-- The attribute first, because a car on a shift is a different height and
	-- CarBuild.HEIGHT is only the hatchback's. An explicit argument still wins.
	local yBase = bodyY or (model:GetAttribute("BodyY") :: number?) or (CarBuild.HEIGHT * S * 0.5)
	local pivot = CFrame.new(x * S, yBase, y * S) * CFrame.Angles(0, -h - math.pi * 0.5, 0)
	model:PivotTo(pivot)
end

return CarBuild
