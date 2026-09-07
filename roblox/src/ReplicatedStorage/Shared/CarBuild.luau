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

-- The model's PrimaryPart sits at the car's centre, at ground level plus half
-- the body height, with -Z along the car's nose. Everything else is welded to
-- it by offset, so the whole car moves with one PivotTo.
function CarBuild.new(colour: Color3): Model
	local L, W, H = CarBuild.LENGTH * S, CarBuild.WIDTH * S, CarBuild.HEIGHT * S

	local model = Instance.new("Model")
	model.Name = "Car"

	-- the hull: two thirds of the height, full length
	local body = box("Body", W, H * 0.62, L, colour)
	body.Parent = model
	model.PrimaryPart = body

	-- the cabin, set back and inset, which is what makes it read as a car
	-- rather than as a brick
	local cabin = box("Cabin", W * 0.86, H * 0.5, L * 0.46, colour:Lerp(Color3.new(0, 0, 0), 0.18))
	cabin.Parent = model

	local glass = box("Glass", W * 0.88, H * 0.3, L * 0.44, Color3.fromRGB(60, 74, 88))
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
		w.CFrame = CFrame.new(off.X * W * 0.46, -H * 0.28, off.Z * L * 0.32)
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
	local function lamp(name: string, colour: Color3, x: number, z: number)
		local p = box(name, W * 0.2, H * 0.16, L * 0.05, colour)
		p.Material = Enum.Material.Neon
		p.CFrame = CFrame.new(x, -H * 0.02, z)
		p.Parent = model
	end
	local nose = -L * 0.5
	local tail = L * 0.5
	lamp("HeadL", Color3.fromRGB(255, 246, 214), -W * 0.3, nose)
	lamp("HeadR", Color3.fromRGB(255, 246, 214), W * 0.3, nose)
	lamp("TailL", Color3.fromRGB(226, 46, 42), -W * 0.3, tail)
	lamp("TailR", Color3.fromRGB(226, 46, 42), W * 0.3, tail)

	-- POSITIONED ONCE, HERE, relative to the body sitting at the origin. PivotTo
	-- moves a model's parts together and preserves what they are relative to
	-- each other, so laying the car out once at build time is all it needs -- an
	-- earlier version carried a table of per-part offsets and reapplied them
	-- every frame, which is work PivotTo was already doing.
	body.CFrame = CFrame.new()
	-- Set BACK from centre, so the bonnet is longer than the boot and the shape
	-- itself says which way it faces even with the lamps off screen.
	cabin.CFrame = CFrame.new(0, H * 0.55, L * 0.1)
	glass.CFrame = CFrame.new(0, H * 0.56, L * 0.06)

	return model
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
function CarBuild.npc(colour: Color3, lengthM: number, widthM: number, heightM: number, boxy: boolean): Model
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
	local cabin = box(
		"Cabin",
		W * (if boxy then 0.98 else 0.86),
		cabinH,
		L * (if boxy then 0.82 else 0.46),
		colour:Lerp(Color3.new(0, 0, 0), 0.14)
	)
	cabin.CFrame = CFrame.new(0, (hullH + cabinH) * 0.5 - H * 0.06, L * (if boxy then 0.06 else 0.1))
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

	-- WHERE THE PIVOT WANTS TO BE, so the caller does not have to re-derive the
	-- hull height it was never told. Half the hull, which stands the vehicle on
	-- the road rather than in it.
	model:SetAttribute("BodyY", hullH * 0.5)
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
	local yBase = bodyY or (CarBuild.HEIGHT * S * 0.5)
	local pivot = CFrame.new(x * S, yBase, y * S) * CFrame.Angles(0, -h - math.pi * 0.5, 0)
	model:PivotTo(pivot)
end

return CarBuild
