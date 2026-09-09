--!strict
-- A PERSON, out of six boxes: two legs, two arms, a torso, a head.
--
-- Not a Roblox character. An R6 rig is fifteen-odd parts plus a Humanoid, and a
-- Humanoid is a state machine, a physics controller and a network-ownership
-- decision each -- thirty-four of them standing on pavements would cost more
-- than the entire city does, to run pathfinding and death states that nothing
-- here uses. The pedestrians in js/entities.js are four numbers and a walk
-- cycle; this is the same thing with a shape on it -- SIX boxes rather than
-- three, because js/render3d.js:pushPerson's counter-swinging limbs are the
-- one piece of that shape a single fused leg-box can't show, and a crowd that
-- glides instead of strides reads as wrong the moment more than one of them is
-- on screen at once.
--
-- THE PIVOT IS AT THE FEET, which is the one decision that matters. Everything
-- that draws a person reads `lie`, the angle they have gone over at, and a body
-- falls about the point it is standing on -- so rotating the model about its
-- own feet is what makes a knockdown look like a fall rather than like a plank
-- rotating about its middle. It is also what makes getting up free: the same
-- angle, run back the other way.
--
-- THE LIMBS ARE NOT WELDED. PivotTo moves a model's parts together preserving
-- whatever they are relative to each other, which is exactly wrong for a walk
-- cycle -- the legs and arms have to move relative to the torso every frame.
-- So place() positions the body with one PivotTo (torso, head, the whole
-- upright shape, `lie` and all) and then sets each limb's CFrame directly,
-- swung from its own hip or shoulder in the SAME rotated frame PivotTo just
-- placed everything else in. Four extra CFrame writes a person a frame, against
-- fifteen for a real rig doing the same job.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local S = Meta.studsPerMetre

local PersonBuild = {}

-- metres
PersonBuild.HEIGHT = 1.72
local LEG = 0.86
local TORSO = 0.60
local HEAD = 0.26
local WIDTH = 0.42
local DEPTH = 0.26

-- Each leg is a bit less than half the old single-box width, so the pair
-- together reads as the same pair of legs rather than as two people's worth.
local LEG_W = WIDTH * 0.36
local LEG_GAP = WIDTH * 0.09 -- half the gap between them, so they do not overlap at rest

-- Arms hang from the shoulder to about hip height -- long enough that the
-- swing reads, short enough that they do not scrape the sidewalk on the
-- forward stroke, which is what a full-LEG-length arm did the first time.
local ARM = TORSO + LEG * 0.18
local ARM_W = WIDTH * 0.15
local ARM_DEPTH = DEPTH * 0.85
local ARM_SIDE = WIDTH * 0.5 * 1.06 + ARM_W * 0.5 -- just outside the torso's own edge

-- Radians. A leg swings further than an arm does in a walking (not running)
-- gait, and the JS reference is the same relative split.
local LEG_SWING = math.rad(26)
local ARM_SWING = math.rad(18)

local function box(name: string, sx: number, sy: number, sz: number, colour: Color3, y: number): Part
	local p = Instance.new("Part")
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
	p.CFrame = CFrame.new(0, y, 0)
	return p
end

-- The model faces -Z, matching the car, so the same heading arithmetic places
-- both. PrimaryPart is an invisible zero-height anchor AT THE FEET rather than
-- one of the body parts, because PivotTo moves a model by its PrimaryPart and
-- the pivot has to be the point the body rotates about.
function PersonBuild.new(shirt: Color3, trews: Color3, skin: Color3): Model
	local model = Instance.new("Model")
	model.Name = "Person"

	local root = Instance.new("Part")
	root.Name = "Feet"
	root.Anchored = true
	root.CanCollide = false
	root.CanQuery = false
	root.CanTouch = false
	root.CastShadow = false
	root.Transparency = 1
	root.Size = Vector3.new(0.05, 0.05, 0.05)
	root.CFrame = CFrame.new()
	root.Parent = model
	model.PrimaryPart = root

	-- Legs are built AT THE HIP (y = LEG * S) with the box hanging below it,
	-- because that is the pivot place() swings them from -- built any other
	-- way, the first frame's swing would snap them to a different length.
	for _, side in { -1, 1 } do
		local leg = box(
			if side < 0 then "LegL" else "LegR",
			LEG_W * S,
			LEG * S,
			DEPTH * S,
			trews,
			(LEG - LEG * 0.5) * S
		)
		leg.CFrame = CFrame.new(side * (LEG_W * 0.5 + LEG_GAP) * S, LEG * 0.5 * S, 0)
		leg.Parent = model
	end

	local torso = box("Torso", WIDTH * 1.06 * S, TORSO * S, DEPTH * 1.05 * S, shirt, (LEG + TORSO * 0.5) * S)
	torso.Parent = model

	-- Arms, from the shoulder (top of the torso) down.
	local shoulderY = (LEG + TORSO) * S
	for _, side in { -1, 1 } do
		local arm = box(if side < 0 then "ArmL" else "ArmR", ARM_W * S, ARM * S, ARM_DEPTH * S, shirt, 0)
		arm.CFrame = CFrame.new(side * ARM_SIDE * S, shoulderY - ARM * 0.5 * S, 0)
		arm.Parent = model
	end

	local head = box("Head", HEAD * S, HEAD * S, HEAD * S, skin, (LEG + TORSO + HEAD * 0.55) * S)
	head.Parent = model

	return model
end

-- Put a person on the pavement.
--
--   x, y   METRES in the browser game's world (+x east, +y south)
--   h      facing, radians, 0 = east
--   lie    how far over they have gone: 0 upright, pi/2 flat
--   pz     height above the pavement, in metres -- only ever non-zero mid-throw
--   bob    the walk cycle's own vertical bounce, in metres
--   step   where in the stride, radians -- Pedestrians.Ped.step, the same
--          number the bounce above is already derived from. 0/nil holds the
--          limbs upright (a downed or standing-still body: sin(0) = 0).
--
-- The lie is a rotation about the model's LOCAL X, which is its lateral axis,
-- applied after the yaw -- so somebody knocked down while walking north goes
-- over along the street rather than always toward world east.
function PersonBuild.place(
	model: Model,
	x: number,
	y: number,
	h: number,
	lie: number,
	pz: number,
	bob: number,
	step: number?
)
	if not model.PrimaryPart then
		return
	end
	-- AND LIFTED AS THEY GO OVER, by half their own depth. The pivot is at the
	-- feet and the body is a stack of boxes above it, so rotating flat swings
	-- that stack down to the ground plane -- and a box centred ON the ground is
	-- half under it. Sine of the angle, so it is zero standing up and full when
	-- they are flat, which is exactly when it is needed.
	local lift = math.sin(lie) * DEPTH * 0.5
	local root = CFrame.new(x * S, (pz + bob + lift) * S, y * S)
		* CFrame.Angles(0, -h - math.pi * 0.5, 0)
		* CFrame.Angles(lie, 0, 0)
	model:PivotTo(root)

	-- THE STRIDE. Legs and arms swing about local X -- the same axis `lie`
	-- rotates about, and for the same reason: it is the axis that moves things
	-- forward and back along the way the body is facing. Left leg forward pairs
	-- with right arm forward, which is why the two swing tables below carry
	-- opposite signs on each side.
	local swing = math.sin(step or 0)
	local legL = model:FindFirstChild("LegL") :: BasePart?
	local legR = model:FindFirstChild("LegR") :: BasePart?
	local armL = model:FindFirstChild("ArmL") :: BasePart?
	local armR = model:FindFirstChild("ArmR") :: BasePart?

	if legL then
		legL.CFrame = root
			* CFrame.new((-(LEG_W * 0.5 + LEG_GAP)) * S, LEG * S, 0)
			* CFrame.Angles(swing * LEG_SWING, 0, 0)
			* CFrame.new(0, -LEG * 0.5 * S, 0)
	end
	if legR then
		legR.CFrame = root
			* CFrame.new((LEG_W * 0.5 + LEG_GAP) * S, LEG * S, 0)
			* CFrame.Angles(-swing * LEG_SWING, 0, 0)
			* CFrame.new(0, -LEG * 0.5 * S, 0)
	end
	local shoulderY = (LEG + TORSO) * S
	if armL then
		armL.CFrame = root
			* CFrame.new(-ARM_SIDE * S, shoulderY, 0)
			* CFrame.Angles(-swing * ARM_SWING, 0, 0)
			* CFrame.new(0, -ARM * 0.5 * S, 0)
	end
	if armR then
		armR.CFrame = root
			* CFrame.new(ARM_SIDE * S, shoulderY, 0)
			* CFrame.Angles(swing * ARM_SWING, 0, 0)
			* CFrame.new(0, -ARM * 0.5 * S, 0)
	end
end

return PersonBuild
