--!strict
-- The city the way the browser draws it: extruded footprints, no lattice.
--
-- Each building is its own OSM polygon pulled up to its own height, exactly as
-- js/render3d.js does it, and the ground is a surface with a picture of the
-- streets on it rather than a layer of tiles. Against the voxel path that is
-- 252,817 parts down to 3,039.
--
-- TWO MESHES A BUILDING, walls and roof, because a MeshPart carries one colour
-- and the browser gives a roof its own.
--
-- THE GEOMETRY IS BAKED, THE TRIANGULATION IS NOT DONE HERE. Roofs are cut by
-- earClip() in tools/roblox/6-flat.mjs -- which is the browser's own ear
-- clipper, run offline where it can be checked -- and arrive as indices. This
-- file only turns numbers into vertices.
--
-- WINDING, worked out once and written down, because it is invisible until it
-- is wrong and then the whole city is inside out.
--
--   · A footprint with a positive shoelace area (windingOf == 1) in world
--     (x, z) has, for an edge running d = b - a, its OUTWARD side along
--     (d.z, -d.x). Check it on a square at the origin: the edge (0,0)->(10,0)
--     has d = (1,0), so outward is (0,-1), which points away from a square that
--     lies at positive z. Correct.
--   · A wall quad's triangles must therefore be (A, B', B) and (A, A', B').
--     Taking (A, B, B') gives cross(e1, e2) = (-d.z, 0, d.x) * h, the inward
--     normal -- so the pair below is the reverse of the one that reads
--     naturally.
--   · earClip's positive ordering, laid flat at y, gives a normal of -Y. A roof
--     faces up, so its triangles are reversed too.

local AssetService = game:GetService("AssetService")

local CityFlat = {}

-- ---------------------------------------------------------------- one mesh

-- Build a MeshPart from a list of triangles, each three Vector3 in LOCAL space.
-- Returns nil if EditableMesh is unavailable, which the caller reports once
-- rather than per building.
-- Why this counts its failures rather than swallowing them: see CityFlat.stats.
CityFlat.made = 0
CityFlat.failed = 0
CityFlat.firstError = nil :: string?

local function meshPart(
	tris: { Vector3 },
	colour: Color3,
	at: Vector3,
	material: Enum.Material?
): MeshPart?
	-- HELD OUTSIDE THE pcall SO IT CAN BE DESTROYED WHETHER OR NOT IT THREW.
	--
	-- An EditableMesh is a live resource against a budget, not a throwaway
	-- description. The hex prism gets away with never releasing one because it
	-- makes exactly one; this makes three thousand, and leaking them exhausts
	-- the budget after a handful -- which is why the first version of this drew
	-- one building and then silently stopped. The MeshPart it produces is
	-- independent of it, so the mesh can go the moment the part exists.
	local em: EditableMesh? = nil
	local ok, part = pcall(function()
		em = AssetService:CreateEditableMesh()
		local m = em :: EditableMesh
		local i = 1
		while i <= #tris do
			m:AddTriangle(m:AddVertex(tris[i]), m:AddVertex(tris[i + 1]), m:AddVertex(tris[i + 2]))
			i += 3
		end
		return AssetService:CreateMeshPartAsync(Content.fromObject(m), {
			-- The shell never collides -- the server's boxes do -- so the
			-- cheapest fidelity is the right one, and it stops Roblox building
			-- a hull for every building in the city.
			CollisionFidelity = Enum.CollisionFidelity.Box,
		})
	end)
	if em then
		(em :: EditableMesh):Destroy()
	end

	if not ok or typeof(part) ~= "Instance" then
		CityFlat.failed += 1
		if not CityFlat.firstError then
			CityFlat.firstError = tostring(part)
		end
		return nil
	end
	CityFlat.made += 1
	local p = part :: MeshPart
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	-- TEXTURE, such as Roblox offers it without an uploaded asset: its own
	-- materials. buildingColours already chose a family -- brick, glass,
	-- stucco -- and the bake recovers which, so a brick building is drawn as
	-- brick rather than as a coloured plastic box.
	p.Material = material or Enum.Material.SmoothPlastic
	p.Color = colour
	p.CFrame = CFrame.new(at)
	return p
end

-- ---------------------------------------------------------------- a building

-- `b` is one row out of a baked FlatData chunk.
function CityFlat.building(b, palette: { Color3 }, materials: { Enum.Material }, parent: Instance): number
	local v = b.v
	local n = #v // 2
	if n < 3 then
		return 0
	end
	local half = b.h * 0.5
	local wind = b.wind

	-- ---- walls ----
	local walls: { Vector3 } = {}
	for i = 0, n - 1 do
		local j = (i + 1) % n
		local ax, az = v[i * 2 + 1], v[i * 2 + 2]
		local bx, bz = v[j * 2 + 1], v[j * 2 + 2]

		-- THE ARCHWAY. An edge the passage runs through keeps only its lintel,
		-- so the opening is under it. The gate travels as a line and a
		-- half-width; an edge whose midpoint is inside that band is a wall with
		-- a hole in it, and the rest of the run is untouched.
		local bottom = -half
		if b.gate then
			local mx, mz = (ax + bx) * 0.5 - b.gate.x, (az + bz) * 0.5 - b.gate.z
			if math.abs(mx * -b.gate.uz + mz * b.gate.ux) <= b.gate.w then
				bottom = math.min(-half + b.gate.h, half - 0.5)
			end
		end

		local A = Vector3.new(ax, bottom, az)
		local B = Vector3.new(bx, bottom, bz)
		local A2 = Vector3.new(ax, half, az)
		local B2 = Vector3.new(bx, half, bz)

		if wind > 0 then
			table.insert(walls, A)
			table.insert(walls, B2)
			table.insert(walls, B)
			table.insert(walls, A)
			table.insert(walls, A2)
			table.insert(walls, B2)
		else
			table.insert(walls, A)
			table.insert(walls, B)
			table.insert(walls, B2)
			table.insert(walls, A)
			table.insert(walls, B2)
			table.insert(walls, A2)
		end
	end

	local made = 0
	local at = Vector3.new(b.ox, half, b.oz)
	local w = meshPart(walls, palette[b.wall], at, materials[b.wmat])
	if w then
		w.Name = "Walls"
		w.Parent = parent
		made += 1
	end

	-- ---- roof ----
	local t = b.t
	local roof: { Vector3 } = {}
	local i = 1
	while i <= #t do
		-- reversed, so the normal is +Y; see the note at the top
		for _, k in { t[i + 2], t[i + 1], t[i] } do
			roof[#roof + 1] = Vector3.new(v[k * 2 + 1], half, v[k * 2 + 2])
		end
		i += 3
	end
	if #roof >= 3 then
		local r = meshPart(roof, palette[b.roof], at, materials[b.rmat])
		if r then
			r.Name = "Roof"
			r.Parent = parent
			made += 1
		end
	end

	return made
end

-- ---------------------------------------------------------------- streets

-- THE STREETS ARE DRAWN, NOT PAINTED, and that is a correction.
--
-- The first version put the whole network on one flat part as a Decal. Compact,
-- and wrong in a way that took three symptoms to spot: a top-face decal's
-- orientation is not something the bake can verify, and if it lands rotated or
-- mirrored then the roads you SEE are not the roads the drivable mask knows
-- about. The car then crawls on painted tarmac, runs flat out across painted
-- grass, and hits buildings standing exactly where the picture shows a street.
-- All three were reported at once, and all three were that.
--
-- Ribbons cannot be wrong that way. They are built from the same centrelines
-- the mask is stamped from, in world coordinates, and they are what
-- ribbon() in js/render3d.js draws.
function CityFlat.streets(data, colours, parent: Instance): number
	local made = 0
	for _, layer in { "park", "kerb", "road" } do
		local flat = (data :: any)[layer]
		if not flat or #flat < 9 then
			continue
		end
		local tris = table.create(#flat // 3)
		local i = 1
		while i <= #flat do
			tris[#tris + 1] = Vector3.new(flat[i], flat[i + 1], flat[i + 2])
			i += 3
		end
		-- Already in world coordinates, so the mesh sits at the origin.
		local p = meshPart(tris, colours[layer], Vector3.zero, Enum.Material.SmoothPlastic)
		if p then
			p.Name = layer
			p.Parent = parent
			made += 1
		end
	end
	return made
end

-- ---------------------------------------------------------------- the ground

-- Just a slab under everything, in the plain ground colour. The streets on top
-- of it are geometry now, so this carries no picture and cannot be misoriented.
function CityFlat.ground(halfStuds: number, colour: Color3, parent: Instance): BasePart
	local slab = Instance.new("Part")
	slab.Name = "GroundSurface"
	slab.Anchored = true
	slab.CanCollide = false -- the server's own ground slab is what a car rests on
	slab.CanQuery = false
	slab.CanTouch = false
	slab.CastShadow = false
	slab.Material = Enum.Material.SmoothPlastic
	slab.Color = colour
	slab.Size = Vector3.new(halfStuds * 2, 1, halfStuds * 2)
	slab.Position = Vector3.new(0, -0.5, 0)
	slab.Parent = parent
	return slab
end

return CityFlat
