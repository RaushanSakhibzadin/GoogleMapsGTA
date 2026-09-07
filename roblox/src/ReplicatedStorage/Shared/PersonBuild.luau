--!strict
-- A PERSON, out of three boxes: legs, torso, head.
--
-- Not a Roblox character. An R6 rig is fifteen-odd parts plus a Humanoid, and a
-- Humanoid is a state machine, a physics controller and a network-ownership
-- decision each -- thirty-four of them standing on pavements would cost more
-- than the entire city does, to run pathfinding and death states that nothing
-- here uses. The pedestrians in js/entities.js are four numbers and a walk
-- cycle; this is the same thing with a shape on it.
--
-- THE PIVOT IS AT THE FEET, which is the one decision that matters. Everything
-- that draws a person reads `lie`, the angle they have gone over at, and a body
-- falls about the point it is standing on -- so rotating the model about its
-- own feet is what makes a knockdown look like a fall rather than like a plank
-- rotating about its middle. It is also what makes getting up free: the same
-- angle, run back the other way.

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
-- one of the three body parts, because PivotTo moves a model by its PrimaryPart
-- and the pivot has to be the point the body rotates about.
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

	local legs = box("Legs", WIDTH * S, LEG * S, DEPTH * S, trews, LEG * 0.5 * S)
	legs.Parent = model

	local torso = box("Torso", WIDTH * 1.06 * S, TORSO * S, DEPTH * 1.05 * S, shirt, (LEG + TORSO * 0.5) * S)
	torso.Parent = model

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
--
-- The lie is a rotation about the model's LOCAL X, which is its lateral axis,
-- applied after the yaw -- so somebody knocked down while walking north goes
-- over along the street rather than always toward world east.
function PersonBuild.place(model: Model, x: number, y: number, h: number, lie: number, pz: number, bob: number)
	if not model.PrimaryPart then
		return
	end
	-- AND LIFTED AS THEY GO OVER, by half their own depth. The pivot is at the
	-- feet and the body is a stack of boxes above it, so rotating flat swings
	-- that stack down to the ground plane -- and a box centred ON the ground is
	-- half under it. Sine of the angle, so it is zero standing up and full when
	-- they are flat, which is exactly when it is needed.
	local lift = math.sin(lie) * DEPTH * 0.5
	model:PivotTo(
		CFrame.new(x * S, (pz + bob + lift) * S, y * S)
			* CFrame.Angles(0, -h - math.pi * 0.5, 0)
			* CFrame.Angles(lie, 0, 0)
	)
end

return PersonBuild
