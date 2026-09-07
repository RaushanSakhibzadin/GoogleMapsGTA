--!strict
-- The city out of ORDINARY PARTS. No meshes, no textures, nothing generated at
-- runtime that this file cannot reason about.
--
-- WHY THIS EXISTS. The previous build made a MeshPart per building through
-- EditableMesh, which is genuinely the right shape for the job and which I
-- cannot execute a single line of from where this was written. It failed twice
-- for reasons that were invisible until somebody looked at a screen. Parts and
-- wedges are boring, they are exactly as accurate here, and every one of them
-- can be checked by reading.
--
-- HOW A FOOTPRINT BECOMES A BUILDING WITHOUT A MESH:
--
--   walls   one thin box per footprint edge, stood on end and turned to face
--           along it. Exact -- a wall IS a box.
--   roof    each triangle from the bake's ear clipping, drawn as two wedges.
--           That is the standard Roblox way to draw an arbitrary triangle and
--           it is exact too.
--
-- MATERIALS, NOT TEXTURES. buildingColours already chose brick or glass or
-- stucco for every building; the bake recovers which, and Roblox draws it. That
-- is the whole of the texturing, and it needs no asset.

local CityParts = {}

-- ---------------------------------------------------------------- templates

local function proto(): Part
	local p = Instance.new("Part")
	p.Anchored = true
	p.CanCollide = false -- the server's boxes are what a car hits
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	return p
end

local BOX = proto()
local WEDGE = Instance.new("WedgePart")
WEDGE.Anchored = true
WEDGE.CanCollide = false
WEDGE.CanQuery = false
WEDGE.CanTouch = false
WEDGE.CastShadow = false

-- Thin enough to read as a surface, thick enough that Roblox does not clamp it
-- away: the minimum part dimension is 0.05 studs.
local SHEET = 0.25
local WALL_T = 0.6

-- ---------------------------------------------------------------- a triangle

-- ARBITRARY TRIANGLES ARE TWO RIGHT TRIANGLES, and a WedgePart is a right
-- triangle. Drop a perpendicular from the vertex opposite the longest edge onto
-- that edge, and the two halves are each a wedge. This is the community's
-- standard construction and it is exact -- the rotation is built from the
-- triangle's own axes rather than solved for.
local function triangle(a: Vector3, b: Vector3, c: Vector3, thick: number, parent: Instance): number
	-- put the longest edge between b and c, so a is the apex
	local ab, ac, bc = b - a, c - a, c - b
	if ab:Dot(ab) > ac:Dot(ac) and ab:Dot(ab) > bc:Dot(bc) then
		a, c = c, a
	elseif ac:Dot(ac) > bc:Dot(bc) and ac:Dot(ac) > ab:Dot(ab) then
		a, b = b, a
	end
	ab, ac, bc = b - a, c - a, c - b

	local cross = ac:Cross(ab)
	if cross.Magnitude < 1e-6 then
		return 0 -- degenerate: three points on a line
	end
	local right = cross.Unit
	local up = bc:Cross(right).Unit
	local back = bc.Unit

	local height = math.abs(ab:Dot(up))
	if height < 1e-4 then
		return 0
	end

	local w1 = WEDGE:Clone()
	w1.Size = Vector3.new(thick, height, math.abs(ab:Dot(back)))
	w1.CFrame = CFrame.fromMatrix((a + b) / 2, right, up, back)
	w1.Parent = parent

	local w2 = WEDGE:Clone()
	w2.Size = Vector3.new(thick, height, math.abs(ac:Dot(back)))
	w2.CFrame = CFrame.fromMatrix((a + c) / 2, -right, up, -back)
	w2.Parent = parent

	return 2
end

-- ---------------------------------------------------------------- a building

function CityParts.building(
	b,
	palette: { Color3 },
	materials: { Enum.Material },
	parent: Instance
): number
	local v = b.v
	local n = #v // 2
	if n < 3 then
		return 0
	end

	local made = 0
	local h = b.h
	local wallColour = palette[b.wall]
	local wallMat = materials[b.wmat] or Enum.Material.Concrete

	-- ---- walls: one box an edge ----
	for i = 0, n - 1 do
		local j = (i + 1) % n
		local ax, az = b.ox + v[i * 2 + 1], b.oz + v[i * 2 + 2]
		local bx, bz = b.ox + v[j * 2 + 1], b.oz + v[j * 2 + 2]
		local dx, dz = bx - ax, bz - az
		local len = math.sqrt(dx * dx + dz * dz)
		if len < 0.05 then
			continue
		end

		-- THE ARCHWAY. An edge the passage runs through keeps only its lintel,
		-- so the opening is under it and the rest of the run is untouched.
		local bottom, top = 0, h
		if b.gate then
			local mx = (ax + bx) * 0.5 - (b.ox + b.gate.x)
			local mz = (az + bz) * 0.5 - (b.oz + b.gate.z)
			if math.abs(mx * -b.gate.uz + mz * b.gate.ux) <= b.gate.w then
				bottom = math.min(b.gate.h, h - 0.5)
			end
		end
		local tall = top - bottom
		if tall < 0.1 then
			continue
		end

		local p = BOX:Clone()
		p.Size = Vector3.new(WALL_T, tall, len)
		-- lookAt orients -Z along the edge; the box is symmetric in Z so either
		-- direction gives the same wall.
		p.CFrame = CFrame.lookAt(
			Vector3.new((ax + bx) / 2, bottom + tall / 2, (az + bz) / 2),
			Vector3.new(bx, bottom + tall / 2, bz)
		)
		p.Color = wallColour
		p.Material = wallMat
		p.Parent = parent
		made += 1
	end

	-- ---- roof: two wedges a triangle ----
	local t = b.t
	local roofColour = palette[b.roof]
	local roofMat = materials[b.rmat] or Enum.Material.Concrete
	local roof = Instance.new("Folder")
	roof.Name = "Roof"
	local i = 1
	while i + 2 <= #t do
		local p1 = Vector3.new(b.ox + v[t[i] * 2 + 1], h, b.oz + v[t[i] * 2 + 2])
		local p2 = Vector3.new(b.ox + v[t[i + 1] * 2 + 1], h, b.oz + v[t[i + 1] * 2 + 2])
		local p3 = Vector3.new(b.ox + v[t[i + 2] * 2 + 1], h, b.oz + v[t[i + 2] * 2 + 2])
		made += triangle(p1, p2, p3, SHEET, roof)
		i += 3
	end
	for _, w in roof:GetChildren() do
		local part = w :: BasePart
		part.Color = roofColour
		part.Material = roofMat
	end
	roof.Parent = parent

	return made
end

-- ---------------------------------------------------------------- streets

-- A straight run of road IS a box: width across, length along, thin. No mesh,
-- and it lands exactly on the centreline the drivable mask was stamped from.
function CityParts.streets(data, meta, parent: Instance): number
	local made = 0

	for _, layer in { "kerb", "road" } do
		local seg = (data :: any)[layer]
		if not seg then
			continue
		end
		local colour = meta.colours[layer]
		local y = meta.lift[layer]
		local i = 1
		while i + 4 <= #seg do
			local ax, az, bx, bz, w = seg[i], seg[i + 1], seg[i + 2], seg[i + 3], seg[i + 4]
			local dx, dz = bx - ax, bz - az
			local len = math.sqrt(dx * dx + dz * dz)
			if len >= 0.05 then
				local p = BOX:Clone()
				p.Size = Vector3.new(w, SHEET, len)
				p.CFrame = CFrame.lookAt(Vector3.new((ax + bx) / 2, y, (az + bz) / 2), Vector3.new(bx, y, bz))
				p.Color = colour
				p.Material = Enum.Material.SmoothPlastic
				p.Parent = parent
				made += 1
			end
			i += 5
		end
	end

	local park = (data :: any).park
	if park then
		local y = meta.lift.park
		local folder = Instance.new("Folder")
		folder.Name = "Park"
		local i = 1
		while i + 5 <= #park do
			made += triangle(
				Vector3.new(park[i], y, park[i + 1]),
				Vector3.new(park[i + 2], y, park[i + 3]),
				Vector3.new(park[i + 4], y, park[i + 5]),
				SHEET,
				folder
			)
			i += 6
		end
		for _, w in folder:GetChildren() do
			local part = w :: BasePart
			part.Color = meta.colours.park
			part.Material = Enum.Material.Grass
		end
		folder.Parent = parent
	end

	return made
end

-- ---------------------------------------------------------------- the ground

function CityParts.ground(halfStuds: number, colour: Color3, parent: Instance): BasePart
	local slab = BOX:Clone()
	slab.Name = "GroundSurface"
	slab.Size = Vector3.new(halfStuds * 2, 1, halfStuds * 2)
	slab.Position = Vector3.new(0, -0.5, 0)
	slab.Color = colour
	slab.Material = Enum.Material.Concrete
	slab.Parent = parent
	return slab
end

return CityParts
