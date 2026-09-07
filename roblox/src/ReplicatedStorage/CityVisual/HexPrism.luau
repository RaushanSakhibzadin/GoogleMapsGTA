--!strict
-- ONE HEXAGONAL PRISM, built at runtime, cloned tens of thousands of times.
--
-- Roblox has no hexagonal primitive. Parts are blocks, spheres, cylinders and
-- wedges, and none of those tiles into a honeycomb. So the mesh is generated
-- here with EditableMesh and turned into a MeshPart that everything else
-- clones -- no uploaded asset, nothing to moderate, and it costs one mesh for
-- the whole city.
--
-- PROPORTIONS. The prism is generated with circumradius 1 and height 1, so its
-- bounding box is sqrt(3) x 1 x 2 -- flat-to-flat across X, corner-to-corner
-- along Z, pointy-top, matching the axial lattice in tools/roblox/lattice.mjs
-- exactly. Roblox scales a MeshPart to fill its Size, so a prism of radius R
-- and height H is Size = (sqrt(3)R, H, 2R): keep that X:Z ratio and the
-- hexagon stays regular at any size.
--
-- AND THERE IS A FALLBACK, because this is the one piece of the project that
-- depends on an API I cannot test from here. If EditableMesh is unavailable or
-- refuses, the city is built from blocks instead -- square, not what was asked
-- for, but a city you can see and drive in rather than an empty world and a
-- stack trace. It says which one it used in the output.

local AssetService = game:GetService("AssetService")

local HexPrism = {}

local SQRT3 = math.sqrt(3)

-- Corner k of a unit hexagon, pointy-top: a corner at +Z, flats facing +/-X.
local function corner(k: number): (number, number)
	local a = math.rad(90 + 60 * k)
	return math.cos(a), math.sin(a)
end

local function buildMesh(): MeshPart?
	local ok, result = pcall(function()
		local em = AssetService:CreateEditableMesh()

		local top: { number } = {}
		local bot: { number } = {}
		for k = 0, 5 do
			local cx, cz = corner(k)
			top[k + 1] = em:AddVertex(Vector3.new(cx, 0.5, cz))
			bot[k + 1] = em:AddVertex(Vector3.new(cx, -0.5, cz))
		end

		-- caps, as fans from the first corner: four triangles each
		for k = 2, 5 do
			em:AddTriangle(top[1], top[k], top[k + 1])
			em:AddTriangle(bot[1], bot[k + 1], bot[k]) -- reversed, so it faces down
		end

		-- six side quads, two triangles apiece
		for k = 1, 6 do
			local n = if k == 6 then 1 else k + 1
			em:AddTriangle(top[k], bot[k], bot[n])
			em:AddTriangle(top[k], bot[n], top[n])
		end

		return AssetService:CreateMeshPartAsync(Content.fromObject(em), {
			-- The shell never collides -- the server's boxes do -- so the
			-- cheapest fidelity is the right one. It also avoids Roblox trying
			-- to build a collision hull for every one of these.
			CollisionFidelity = Enum.CollisionFidelity.Box,
		})
	end)

	if ok and typeof(result) == "Instance" then
		return result :: MeshPart
	end
	warn("[hex] EditableMesh unavailable (" .. tostring(result) .. ") -- falling back to blocks")
	return nil
end

local cached: BasePart? = nil
local isReal = false

-- The template to clone. A MeshPart if the mesh could be made, otherwise a
-- plain Part, so callers do not have to branch.
function HexPrism.template(): (BasePart, boolean)
	if cached then
		return cached :: BasePart, isReal
	end

	local mesh = buildMesh()
	local p: BasePart
	if mesh then
		p = mesh
		isReal = true
	else
		p = Instance.new("Part")
		;(p :: Part).Shape = Enum.PartType.Block
		isReal = false
	end

	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.Material = Enum.Material.SmoothPlastic
	cached = p
	return p, isReal
end

-- Size for a prism of circumradius R studs and the given height. The X:Z ratio
-- is what keeps the hexagon regular; getting it wrong gives a squashed one that
-- no longer tiles with its neighbours, leaving gaps down every seam.
function HexPrism.size(radius: number, height: number): Vector3
	return Vector3.new(SQRT3 * radius, height, 2 * radius)
end

-- The fallback's square footprint. Flat-to-flat, so a block sits inside the
-- hexagon it stands in for and the city does not grow when the mesh fails.
function HexPrism.blockSize(radius: number, height: number): Vector3
	return Vector3.new(SQRT3 * radius, height, SQRT3 * radius)
end

return HexPrism
