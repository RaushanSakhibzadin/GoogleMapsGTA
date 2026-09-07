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
local function meshPart(tris: { Vector3 }, colour: Color3, at: Vector3): MeshPart?
	local ok, part = pcall(function()
		local em = AssetService:CreateEditableMesh()
		local i = 1
		while i <= #tris do
			em:AddTriangle(em:AddVertex(tris[i]), em:AddVertex(tris[i + 1]), em:AddVertex(tris[i + 2]))
			i += 3
		end
		return AssetService:CreateMeshPartAsync(Content.fromObject(em), {
			-- The shell never collides -- the server's boxes do -- so the
			-- cheapest fidelity is the right one, and it stops Roblox building
			-- a hull for every building in the city.
			CollisionFidelity = Enum.CollisionFidelity.Box,
		})
	end)
	if not ok or typeof(part) ~= "Instance" then
		return nil
	end
	local p = part :: MeshPart
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.Material = Enum.Material.SmoothPlastic
	p.Color = colour
	p.CFrame = CFrame.new(at)
	return p
end

-- ---------------------------------------------------------------- a building

-- `b` is one row out of a baked FlatData chunk.
function CityFlat.building(b, palette: { Color3 }, parent: Instance): number
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
	local w = meshPart(walls, palette[b.wall], at)
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
		local r = meshPart(roof, palette[b.roof], at)
		if r then
			r.Name = "Roof"
			r.Parent = parent
			made += 1
		end
	end

	return made
end

-- ---------------------------------------------------------------- the ground

-- One flat part with the streets painted on it, rather than a layer of tiles.
function CityFlat.ground(tex, decode: (string) -> buffer, parent: Instance): BasePart
	local half = tex.halfStuds
	local slab = Instance.new("Part")
	slab.Name = "GroundSurface"
	slab.Anchored = true
	slab.CanCollide = false -- the server's own ground slab is what a car rests on
	slab.CanQuery = false
	slab.CanTouch = false
	slab.CastShadow = false
	slab.Material = Enum.Material.SmoothPlastic
	slab.Color = tex.palette[1]
	slab.Size = Vector3.new(half * 2, 1, half * 2)
	slab.Position = Vector3.new(0, -0.5, 0)
	slab.Parent = parent

	local ok, err = pcall(function()
		local px = tex.px
		local bits = decode(tex.bits)
		local rgba = buffer.create(px * px * 4)
		for i = 0, px * px - 1 do
			local cls = (buffer.readu8(bits, i // 4) // (2 ^ ((i % 4) * 2))) % 4
			local c = tex.palette[cls + 1]
			local at = i * 4
			buffer.writeu8(rgba, at, math.floor(c.R * 255))
			buffer.writeu8(rgba, at + 1, math.floor(c.G * 255))
			buffer.writeu8(rgba, at + 2, math.floor(c.B * 255))
			buffer.writeu8(rgba, at + 3, 255)
		end
		local img = AssetService:CreateEditableImage({ Size = Vector2.new(px, px) })
		img:WritePixelsBuffer(Vector2.zero, Vector2.new(px, px), rgba)

		local d = Instance.new("Decal")
		d.Face = Enum.NormalId.Top
		d.TextureContent = Content.fromObject(img)
		d.Parent = slab
	end)
	if not ok then
		warn("[city] ground texture unavailable (" .. tostring(err) .. ") -- flat colour")
	end
	return slab
end

return CityFlat
