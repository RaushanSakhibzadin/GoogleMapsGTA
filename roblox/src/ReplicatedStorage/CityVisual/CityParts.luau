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

-- A GLASS BAND IS THICKER THAN THE WALL IT SITS IN, and that is the trick that
-- makes windows cheap: proud on both faces, so it shows from the street without
-- anyone having to work out which way the wall faces outward. Getting that
-- direction right per edge is exactly the winding problem that has bitten this
-- project twice; not needing to know it is worth 0.3 of a stud.
local GLASS_T = 1.0
local COURSE = 1.4 * 3 -- a window course is about 1.4 m tall
local PIER = 1.2 -- studs of solid wall left at each corner

-- A COURSE WAS ONE BOX THE FULL LENGTH OF THE WALL RUN, which is exact and
-- cheap and, on anything longer than about six metres, reads as a single
-- ribbon rather than as windows -- reported as "windows look like lines".
-- Chopping it into segments this wide, with a pier-width gap between them,
-- turns the ribbon into what it is standing in for: a row of window bays.
-- Still one glass box a bay rather than one a pane, so the part cost stays a
-- small, bounded multiple of what a single band already cost, not a jump to
-- one-box-per-real-window.
local WIN_SEG = 6 -- studs, one bay's own width
local WIN_GAP = 1.4 -- studs, the pier between bays

-- Deterministic 0..1, the same sin-based mix the bake uses for heights and the
-- browser uses for its own per-building choices -- so which windows are lit is
-- stable across a rejoin instead of flickering on every build.
local function hash01(a: number, b: number): number
	local x = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
	return x - math.floor(x)
end

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

function CityParts.building(b, meta, parent: Instance): number
	local palette: { Color3 } = meta.palette
	local materials: { Enum.Material } = meta.materials
	local glassColour: Color3 = meta.glass
	local litColour: Color3 = meta.lit
	local litFrac: number = meta.litFrac
	local storeyStuds: number = meta.storeyStuds
	local v = b.v
	local n = #v // 2
	if n < 3 then
		return 0
	end

	local made = 0
	local h = b.h
	local wallColour = palette[b.wall]
	local wallMat = materials[b.wmat] or Enum.Material.Concrete

	-- WHERE THE PASSAGE ACTUALLY OPENED. Every edge within b.gate.w of the
	-- gate's line gets its bottom cut -- normally exactly two, the near wall
	-- and the far one, since a line through a roughly convex footprint
	-- crosses its boundary twice. Recorded so the passage can be given a
	-- ceiling after the wall loop: cutting a hole through a hollow shell with
	-- nothing to cap it is what "you can see the insides of buildings" was.
	local gateOpenings: { Vector3 } = {}

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
				gateOpenings[#gateOpenings + 1] = Vector3.new((ax + bx) / 2, bottom, (az + bz) / 2)
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

		-- ---- windows: a glass band a storey ----
		--
		-- Set into the wall run rather than replacing it, so the wall behind
		-- stays solid and a window is a band of glass across the facade. The
		-- courses start one storey up (the ground floor is a shopfront) and
		-- stop short of the top (a plain cornice), which is what the browser's
		-- shader does and what stops a roofline cutting a row in half.
		--
		-- ONLY THE FACES YOU CAN SEE. `wmin` is the length cutoff the bake
		-- worked out for this building: its longest few edges, and none shorter
		-- than a facade. Banding every edge came to 130,538 Parts on the 2.4 km
		-- district -- more than its walls and roofs put together -- to put
		-- windows on the backs of buildings and on the two-metre jogs where a
		-- terrace steps. One comparison here and no sort, because the bake sends
		-- a cutoff rather than a list.
		local courses = b.st or 0
		if courses > 0 and len >= (b.wmin or 4) and bottom == 0 then
			local bandLen = math.max(1, len - PIER)
			local dirX, dirZ = dx / len, dz / len
			local mx, mz = (ax + bx) / 2, (az + bz) / 2

			-- BAYS, not one ribbon. `pitch` is bandLen shared out evenly over
			-- segCount bays so the run divides exactly -- no giant leftover
			-- gap parked at one end -- and `segLen` is what is left of each
			-- pitch once its own trailing gap is taken out.
			local segStep = WIN_SEG + WIN_GAP
			local segCount = math.max(1, math.floor((bandLen + WIN_GAP) / segStep))
			local pitch = bandLen / segCount
			local segLen = math.max(1, pitch - WIN_GAP)
			local startX, startZ = mx - dirX * bandLen * 0.5, mz - dirZ * bandLen * 0.5

			for k = 1, courses do
				local y = k * storeyStuds
				if y + COURSE * 0.5 > h then
					break
				end
				for s = 0, segCount - 1 do
					local d = (s + 0.5) * pitch
					local sx, sz = startX + dirX * d, startZ + dirZ * d
					local lit = hash01(math.floor(sx * 7 + sz * 13) + i * 31, k * 97 + s) < litFrac
					local g = BOX:Clone()
					g.Size = Vector3.new(GLASS_T, COURSE, segLen)
					g.CFrame = CFrame.lookAt(Vector3.new(sx, y, sz), Vector3.new(sx + dirX, y, sz + dirZ))
					g.Color = if lit then litColour else glassColour
					g.Material = if lit then Enum.Material.Neon else Enum.Material.Glass
					g.Parent = parent
					made += 1
				end
			end
		end
	end

	-- ---- the archway's own ceiling ----
	--
	-- A gate is a hole cut clean through the shell -- there is no floor, no
	-- interior wall, nothing inside a flat-extruded building except its own
	-- four walls and a roof way up top. Uncapped, walking under one shows
	-- exactly that emptiness. A slab at the lintel's height, spanning
	-- entry to exit, is what turns "a hole in a box" back into "a covered
	-- passage" -- the one piece of interior a building this simple needs.
	if b.gate and #gateOpenings >= 1 then
		local gy = b.gate.h
		local cx, cz, dirX, dirZ, length
		if #gateOpenings >= 2 then
			-- Between the two real cuts, which is exact regardless of how
			-- thick the building is at this point.
			local p1, p2 = gateOpenings[1], gateOpenings[#gateOpenings]
			cx, cz = (p1.X + p2.X) / 2, (p1.Z + p2.Z) / 2
			local ddx, ddz = p2.X - p1.X, p2.Z - p1.Z
			length = math.sqrt(ddx * ddx + ddz * ddz)
			if length > 0.1 then
				dirX, dirZ = ddx / length, ddz / length
			else
				dirX, dirZ = b.gate.ux, b.gate.uz
			end
		else
			-- Only one wall on the gate's line was thin enough to open (a
			-- passage cut into a corner, say). No far edge to measure to, so
			-- a generous fixed depth stands in for "as deep as a passage
			-- actually runs" -- long enough to read as covered from the
			-- street, short of guessing wrong in a way that pokes out the
			-- building's own far side.
			local p1 = gateOpenings[1]
			cx, cz = p1.X, p1.Z
			dirX, dirZ = b.gate.ux, b.gate.uz
			length = 12
		end
		local ceiling = BOX:Clone()
		-- +2 so it laps the lintels on both ends rather than leaving a
		-- hairline gap where the ceiling would otherwise butt exactly against
		-- the wall it is capping.
		ceiling.Size = Vector3.new(b.gate.w * 2, SHEET, length + 2)
		ceiling.CFrame = CFrame.lookAt(Vector3.new(cx, gy, cz), Vector3.new(cx + dirX, gy, cz + dirZ))
		ceiling.Color = wallColour
		ceiling.Material = wallMat
		ceiling.Parent = parent
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

-- ---------------------------------------------------------------- the trees

-- TWO PARTS A TREE, and no mesh: a cylinder for the trunk and an ellipsoid for
-- the canopy. Roblox has no cone primitive, which is the only reason a conifer
-- here is a tall narrow ellipsoid rather than a spire -- and a narrow upright
-- crown is what a Belgrade poplar looks like anyway, so it is not much of a
-- compromise.
--
-- A CYLINDER PART'S AXIS IS ITS X, which is the one thing about this that is
-- not obvious: Size is (length, diameter, diameter) and it lies down until you
-- stand it up, so the quarter turn about Z below is what makes a trunk a trunk
-- rather than a log.
--
-- Every number arrives from the bake in studs and every position was already
-- checked against the real footprints and the real carriageway widths, so this
-- places what it is given and tests nothing.
function CityParts.trees(data, parent: Instance, onEach: (() -> ())?): number
	local colours = data.colours
	local leaf = { colours.leafA, colours.leafB, colours.conifer }
	local made = 0

	for _, t in data.trees :: { { number } } do
		if onEach then
			(onEach :: () -> ())()
		end
		local x, z, h, spread, bare, form = t[1], t[2], t[3], t[4], t[5], t[6]

		local trunkD = math.max(0.35, spread * 0.11)
		local trunk = BOX:Clone()
		trunk.Shape = Enum.PartType.Cylinder
		trunk.Size = Vector3.new(bare + spread * 0.3, trunkD, trunkD)
		trunk.CFrame = CFrame.new(x, (bare + spread * 0.3) * 0.5, z) * CFrame.Angles(0, 0, math.pi * 0.5)
		trunk.Color = colours.trunk
		trunk.Material = Enum.Material.Wood
		trunk.Parent = parent

		local crown = h - bare
		local canopy = BOX:Clone()
		canopy.Shape = Enum.PartType.Ball
		-- A Ball part is a sphere at its smallest dimension and an ellipsoid
		-- otherwise, which is the whole of the species difference: form 2 is
		-- taller than it is wide, the broadleaves are wider than they are tall.
		canopy.Size = if form == 2
			then Vector3.new(spread, crown, spread)
			else Vector3.new(spread, crown * 0.92, spread)
		canopy.CFrame = CFrame.new(x, bare + crown * 0.5, z)
		canopy.Color = leaf[form + 1]
		canopy.Material = Enum.Material.LeafyGrass
		canopy.Parent = parent

		made += 2
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
