--!strict
-- The minimap: a circle of the district, turning with the car.
--
-- PAINTED, NOT UPLOADED. Roblox cannot ship an image without it being an
-- uploaded asset, which means Open Cloud and a moderation pass for something
-- regenerated every time the district changes. So the bake rasterises the whole
-- district to two bits a pixel -- 256 kB for 1024 squared, against 3 MB as RGB
-- -- and this samples out of it into an EditableImage. Same principle as
-- proctex.js: nothing in this project is a file somebody drew.
--
-- AND SAMPLED PER FRAME RATHER THAN SLID ABOUT, which is the decision that
-- makes both of the things asked for possible at once.
--
-- The obvious build is an ImageLabel of the whole district inside a clipping
-- frame, moved so the player is centred -- cheap, and what this did first. But
-- ClipsDescendants is RECTANGULAR and there is no other clip in Roblox, so a
-- round panel is not expressible that way; and rotating the sheet leaves the
-- corners swinging in and out of a square hole.
--
-- Generating the visible image instead solves both at once and adds a third
-- thing for nothing: the outline is just which pixels get an alpha, the
-- rotation is just what the sample offsets are rotated by, and the shape can
-- change by editing one comparison.
--
-- IT WAS A HEXAGON, and the hexagon was for the voxel city that this no longer
-- draws: a pointy-top panel over a pointy-top lattice read as the same shape
-- twice. The lattice went when the buildings became extruded footprints (§5.4)
-- and the hexagon outlived the reason for it. A circle is also the honest shape
-- for what this shows -- the sample window is a radius about the car, and a
-- hexagon was drawing the corners of a circle it did not have.
--
-- THE COST IS THE RESOLUTION, so it is small on purpose: 96 squared is 9,216
-- samples an update at 20 Hz, which is a fifth of what 60 Hz at panel
-- resolution would be. A minimap does not need either.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local AssetService = game:GetService("AssetService")

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera
local Shared = ReplicatedStorage:WaitForChild("Shared")
local ClientBus = require(Shared:WaitForChild("ClientBus"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Board = Remotes:WaitForChild("IncidentBoard") :: RemoteEvent

-- The raster, the palette and the lookup all come from CityVisual/MapPaint,
-- which the big map reads too. They are the same picture at two scales, and a
-- second copy of the decode here is a second chance for the two to disagree --
-- which is exactly how the world and this map ended up running opposite ground
-- palettes once already.
local MapPaint = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("MapPaint"))
local CLASS = MapPaint.CLASS
local classAt = MapPaint.classAt

local VIEW = 196 -- the panel on screen, in GUI pixels
local RES = 96 -- the image behind it; chunky on purpose
local SPAN = 620 -- studs across the panel: about 200 m of city
local HZ = 20 -- redraws a second

-- ---------------------------------------------------------------- the panel

local gui = Instance.new("ScreenGui")
gui.Name = "Minimap"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.Parent = player:WaitForChild("PlayerGui")

-- A BUTTON, NOT A FRAME. Tapping the minimap opens the big map -- which is what
-- you reach for when the minimap is not enough, and reaching for it by tapping
-- the thing you were already looking at is the obvious gesture. The blips and
-- the arrow are children of it and do not swallow the tap: a Frame does not
-- take input unless something asks it to.
local panel = Instance.new("TextButton")
panel.Size = UDim2.fromOffset(VIEW, VIEW)
panel.Position = UDim2.new(1, -VIEW - 18, 0, 18)
panel.BackgroundTransparency = 1
panel.Text = ""
panel.AutoButtonColor = false
panel.Parent = gui

panel.Activated:Connect(function()
	ClientBus.toggleMap:Fire()
end)

-- A BACKING CIRCLE, always present, not only when EditableImage fails. The
-- sheet ImageLabel is itself BackgroundTransparency 1 -- it is a picture with
-- nothing behind it -- and when EditableImage is unavailable that picture
-- never arrives at all (image stays nil, sheet.ImageContent is never set),
-- which is what "blips only" actually looked like: the blips, floating on
-- whatever the player's own view happened to be behind the panel, not a
-- radar. This is the radar's own dark ground, drawn once, so a panel with no
-- rasterised city on it still reads as an instrument rather than a hole.
local backdrop = Instance.new("Frame")
backdrop.Size = UDim2.fromScale(1, 1)
backdrop.BackgroundColor3 = Color3.fromRGB(14, 15, 19)
backdrop.BorderSizePixel = 0
backdrop.Parent = panel
local backdropCorner = Instance.new("UICorner")
backdropCorner.CornerRadius = UDim.new(1, 0)
backdropCorner.Parent = backdrop

local sheet = Instance.new("ImageLabel")
sheet.Size = UDim2.fromScale(1, 1)
sheet.BackgroundTransparency = 1
sheet.ScaleType = Enum.ScaleType.Stretch
-- No smoothing: at 96 across a 196 pixel panel the samples ARE the look, and
-- bilinear would blur the street edges into porridge.
sheet.ResampleMode = Enum.ResamplerMode.Pixelated
sheet.Parent = panel

-- ---------------------------------------------------------------- the circle

-- Which output pixels are inside the panel, worked out once. One comparison,
-- because the shape is a circle.
--
-- ALPHA IS FEATHERED OVER THE LAST PIXEL rather than cut hard. At 96 across, a
-- hard threshold gives a visibly stepped rim -- the shape is only 96 samples
-- wide and the staircase is a couple of pixels deep at the diagonals. Roblox
-- has no anti-aliasing to lean on here because this IS the image; a one-pixel
-- ramp costs nothing and is the difference between a circle and a cog.
local EDGE: { number } = table.create(RES * RES, 0)
do
	local c = (RES - 1) / 2
	local R = c - 0.5
	for j = 0, RES - 1 do
		for i = 0, RES - 1 do
			local dx, dy = i - c, j - c
			local d = math.sqrt(dx * dx + dy * dy)
			-- 1 well inside, 0 outside, a linear ramp across the last pixel
			EDGE[j * RES + i + 1] = math.clamp(R - d, 0, 1)
		end
	end
end

-- ---------------------------------------------------------------- the image

local image: EditableImage? = nil
local rgba = buffer.create(RES * RES * 4)
do
	local ok, err = pcall(function()
		image = AssetService:CreateEditableImage({ Size = Vector2.new(RES, RES) })
	end)
	if not ok then
		warn("[minimap] EditableImage unavailable (" .. tostring(err) .. ") -- blips only")
		image = nil
	end
end

-- ---------------------------------------------------------------- blips

local function dot(size: number, colour: Color3, z: number): Frame
	local f = Instance.new("Frame")
	f.Size = UDim2.fromOffset(size, size)
	f.AnchorPoint = Vector2.new(0.5, 0.5)
	f.BackgroundColor3 = colour
	f.BorderSizePixel = 0
	f.ZIndex = z
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(1, 0)
	c.Parent = f
	f.Parent = panel
	return f
end

-- The car sits in the middle and always points UP, because the map turns
-- instead. That is the whole difference between a heading-up map and a
-- north-up one, and it is why the arrow needs no rotation of its own.
local me = Instance.new("Frame")
me.Size = UDim2.fromOffset(4, 12)
me.AnchorPoint = Vector2.new(0.5, 0.5)
me.Position = UDim2.fromOffset(VIEW / 2, VIEW / 2)
me.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
me.BorderSizePixel = 0
me.ZIndex = 10
me.Parent = panel
local meCorner = Instance.new("UICorner")
meCorner.CornerRadius = UDim.new(1, 0)
meCorner.Parent = me

-- AN INCIDENT BLIP IS THREE PIECES: the dot itself, a distance readout that
-- only shows once the incident is off the radar's own radius (a rim pointer
-- that says nothing about how far is not much of a pointer), and a pulse
-- ring that grows and fades on the ones this shift can actually take -- the
-- same "which of these is mine to do" question the big map answers with a
-- dimmed dot, answered here with motion instead, because at 9 px a dimming
-- is not something a glance at the corner of the screen reads.
local function incidentBlip(): Frame
	local f = dot(9, Color3.fromRGB(255, 140, 40), 8)

	local dist = Instance.new("TextLabel")
	dist.Name = "Dist"
	dist.AnchorPoint = Vector2.new(0.5, 0)
	dist.Position = UDim2.fromOffset(0, 8)
	dist.Size = UDim2.fromOffset(44, 12)
	dist.BackgroundTransparency = 1
	dist.Font = Enum.Font.GothamBold
	dist.TextSize = 10
	dist.TextColor3 = Color3.fromRGB(255, 255, 255)
	dist.TextStrokeTransparency = 0.4
	dist.Text = ""
	dist.Visible = false
	dist.ZIndex = 9
	dist.Parent = f

	local ring = Instance.new("Frame")
	ring.Name = "Pulse"
	ring.AnchorPoint = Vector2.new(0.5, 0.5)
	ring.Position = UDim2.fromScale(0.5, 0.5)
	ring.BackgroundTransparency = 1
	ring.BorderSizePixel = 0
	ring.ZIndex = 6
	ring.Visible = false
	local ringCorner = Instance.new("UICorner")
	ringCorner.CornerRadius = UDim.new(1, 0)
	ringCorner.Parent = ring
	local ringStroke = Instance.new("UIStroke")
	ringStroke.Thickness = 2
	ringStroke.Color = Color3.fromRGB(255, 196, 96)
	ringStroke.Parent = ring
	ring.Parent = f

	return f
end

local blips: { Frame } = {}
local board: { any } = {}
Board.OnClientEvent:Connect(function(list)
	board = list
end)

-- ---------------------------------------------------------------- depots

-- THE DEPOT YOU ARE NEAR, and only that one.
--
-- The big map draws all twenty-seven, because that is a map you have opened to
-- decide where to drive. This is a 190-pixel circle showing 300 m of city, and
-- putting nine clinics on it would fill it with dots for buildings you are not
-- going to -- so the minimap shows the nearest sign-on depot and nothing else,
-- and only once you are close enough for it to be a thing you might do.
--
-- SMALLER AND DARKER THAN AN INCIDENT, deliberately: a job is what you are
-- meant to look at, and a depot is furniture until you want it.
local SHOW_NEAR = 600
local DEPOT_COLOUR: { [string]: Color3 } = {
	fire = Color3.fromRGB(226, 72, 56),
	police = Color3.fromRGB(96, 152, 230),
	hospital = Color3.fromRGB(240, 240, 244),
	clinic = Color3.fromRGB(255, 146, 166),
	taxi = Color3.fromRGB(242, 183, 5),
	fuel = Color3.fromRGB(229, 207, 122),
}
-- Same letters BigMap wears on its own twenty-seven -- one glance says which
-- service this is without already knowing the palette. The fallbacks read as
-- the real thing they stand in for, matching DEPOT_COLOUR's own choice.
local DEPOT_GLYPH: { [string]: string } = {
	fire = "F",
	police = "P",
	hospital = "H",
	clinic = "H",
	taxi = "T",
	fuel = "T",
}
local depotDot = dot(7, Color3.fromRGB(150, 156, 166), 7)
depotDot.BackgroundTransparency = 0.25
depotDot.Visible = false
local depotGlyph = Instance.new("TextLabel")
depotGlyph.Size = UDim2.fromScale(1, 1)
depotGlyph.BackgroundTransparency = 1
depotGlyph.Font = Enum.Font.GothamBold
depotGlyph.TextSize = 6
depotGlyph.TextColor3 = Color3.fromRGB(20, 20, 24)
depotGlyph.Text = ""
depotGlyph.ZIndex = 8
depotGlyph.Parent = depotDot

-- ---------------------------------------------------------------- the objective arrow

-- WHERE THE MINIMAP CANNOT REACH. The radar is a 300 m window; a job you are
-- actually driving to is routinely further off than that, and the one thing
-- worth knowing about it every second -- which way -- is exactly what a dot
-- clamped to a tiny rim across the screen stops being able to say clearly.
-- js/render.js:drawArrow did this in 2D with its own screen-space geometry;
-- Roblox's Camera:WorldToViewportPoint is the same question already answered
-- by the engine, projection matrix and all.
local arrow = Instance.new("TextLabel")
arrow.Name = "ObjectiveArrow"
arrow.AnchorPoint = Vector2.new(0.5, 0.5)
arrow.Size = UDim2.fromOffset(28, 28)
arrow.BackgroundTransparency = 1
arrow.Font = Enum.Font.GothamBold
arrow.TextSize = 22
arrow.TextColor3 = Color3.fromRGB(255, 176, 64)
arrow.TextStrokeTransparency = 0.2
arrow.Text = "▲"
arrow.Visible = false
arrow.ZIndex = 15
arrow.Parent = gui

local arrowDist = Instance.new("TextLabel")
arrowDist.Name = "Dist"
arrowDist.AnchorPoint = Vector2.new(0.5, 0)
arrowDist.Position = UDim2.new(0.5, 0, 1, 2)
arrowDist.Size = UDim2.fromOffset(60, 14)
arrowDist.BackgroundTransparency = 1
arrowDist.Font = Enum.Font.GothamBold
arrowDist.TextSize = 12
arrowDist.TextColor3 = Color3.fromRGB(255, 255, 255)
arrowDist.TextStrokeTransparency = 0.3
arrowDist.Text = ""
arrowDist.ZIndex = 15
arrowDist.Parent = arrow

-- Kept off the screen's own edge, so the arrow's glyph and its distance
-- label both stay fully on screen at every angle rather than being clipped
-- by whichever side they are pointing towards.
local ARROW_MARGIN = 70

-- ---------------------------------------------------------------- the frame

local function carPivot(): CFrame?
	local cars = workspace:FindFirstChild("Cars")
	local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
	if model and model:IsA("Model") then
		return model:GetPivot()
	end
	return nil
end

local STUDS_PER_PX = SPAN / RES
local acc = 1 / HZ

-- One pulse a second and a bit, growing from the dot's own size out to
-- about twice the panel's blip spacing while it fades -- fast enough to
-- catch the eye in the corner of the screen, slow enough that it reads as a
-- pulse and not a flicker.
local PULSE_CYCLE = 1.15
local pulseT = 0

RunService.RenderStepped:Connect(function(dt)
	local pivot = carPivot()
	if not pivot then
		return
	end
	local p = pivot.Position
	local look = pivot.LookVector

	-- The car's own axes on the ground. `right` is look turned a quarter turn
	-- clockwise about Y; `back` is straight behind. Screen +x is right and
	-- screen +y is DOWN, which is behind the car -- so these two are exactly the
	-- basis the output pixels are laid out in, and the map comes out heading-up
	-- with no separate rotation step.
	local lx, lz = look.X, look.Z
	local rx, rz = -lz, lx
	local bx, bz = -lx, -lz

	acc += dt
	if image and acc >= 1 / HZ then
		acc = 0
		local c = (RES - 1) / 2
		local at = 0
		for j = 0, RES - 1 do
			local dy = (j - c) * STUDS_PER_PX
			for i = 0, RES - 1 do
				local edge = EDGE[j * RES + i + 1]
				if edge > 0 then
					local dx = (i - c) * STUDS_PER_PX
					local wx = p.X + dx * rx + dy * bx
					local wz = p.Z + dx * rz + dy * bz
					local col = CLASS[classAt(wx, wz)]
					buffer.writeu8(rgba, at, col[1])
					buffer.writeu8(rgba, at + 1, col[2])
					buffer.writeu8(rgba, at + 2, col[3])
					-- The rim's own alpha, so the last pixel fades instead of
					-- stepping. Outside is fully transparent, which is what
					-- makes the panel round at all -- there is no clipping in
					-- Roblox that would do it.
					buffer.writeu8(rgba, at + 3, math.floor(235 * edge))
				else
					buffer.writeu8(rgba, at + 3, 0)
				end
				at += 4
			end
		end
		-- GUARDED, LIKE THE CREATE ABOVE. CreateEditableImage can succeed while
		-- the API is still unusable -- the instance exists but writing to it
		-- throws "EditableImage is not accessible" -- and that only surfaces
		-- here, at 20 Hz. Unguarded, that is not an error, it is a flood: the
		-- console fills with the same line every frame and evicts everything
		-- else out of its history. One warning and the same "blips only"
		-- fallback the constructor already has is the honest response.
		local ok, err = pcall(function()
			local img = image :: EditableImage
			img:WritePixelsBuffer(Vector2.zero, Vector2.new(RES, RES), rgba)
			sheet.ImageContent = Content.fromObject(img)
		end)
		if not ok then
			warn("[minimap] EditableImage unusable (" .. tostring(err) .. ") -- blips only")
			image = nil
		end
	end

	-- Blips, in the same rotated basis as the pixels.
	local n = 0
	local scale = VIEW / SPAN

	-- The nearest sign-on depot, if there is one worth showing. Its GATE, not
	-- its centroid: the gate is where you actually pull up, and on this
	-- district's fire station the two are 51 m apart.
	do
		local best, bestD, bestKind = nil, SHOW_NEAR * SHOW_NEAR, ""
		for _, d in ClientBus.depots do
			local dx, dz = (d.gx or d.x) - p.X, (d.gz or d.z) - p.Z
			local q = dx * dx + dz * dz
			if q < bestD then
				best, bestD, bestKind = { x = d.gx or d.x, z = d.gz or d.z }, q, d.kind
			end
		end
		if best then
			local wx, wz = best.x - p.X, best.z - p.Z
			local sx = (wx * rx + wz * rz) * scale
			local sy = (wx * bx + wz * bz) * scale
			local R = VIEW / 2 - 7
			local d = math.sqrt(sx * sx + sy * sy)
			if d > R then
				sx, sy = sx / d * R, sy / d * R
			end
			depotDot.BackgroundColor3 = DEPOT_COLOUR[bestKind] or Color3.fromRGB(150, 156, 166)
			depotGlyph.Text = DEPOT_GLYPH[bestKind] or ""
			depotDot.Position = UDim2.fromOffset(VIEW / 2 + sx, VIEW / 2 + sy)
			depotDot.Visible = true
		else
			depotDot.Visible = false
		end
	end
	pulseT = (pulseT + dt) % PULSE_CYCLE
	local pulseU = pulseT / PULSE_CYCLE
	local pulseSize = 9 + pulseU * 18
	local pulseTrans = 0.15 + pulseU * 0.85 -- opaque-ish at birth, gone by the end

	for _, inc in board do
		n += 1
		local f = blips[n]
		if not f then
			f = incidentBlip()
			blips[n] = f
		end
		f.Visible = true
		-- The kind's own colour, so the dot and the column over the building
		-- match; dimmed when this shift has no place on it. Same rule as the big
		-- map, and the same reason: with five kinds on the board, most of what is
		-- on it is somebody else's work.
		local canTake = false
		for _, s in inc.slots or {} do
			if s.role == ClientBus.role and s.filled < s.max then
				canTake = true
			end
		end
		-- A RACE ALREADY WON IS NOT STILL TAKEABLE, whatever its slots say --
		-- eight taxis can claim a fare and only one arriving locks it, so
		-- `filled < max` stays true for the seven who lost right through the
		-- drop leg, which is the one this used to pulse for longest.
		if inc.competitive and inc.taken then
			canTake = false
		end
		f.BackgroundColor3 = inc.colour or Color3.fromRGB(255, 140, 40)
		f.BackgroundTransparency = if canTake then 0 else 0.55

		local ring = f:FindFirstChild("Pulse") :: Frame
		ring.Visible = canTake
		if canTake then
			ring.Size = UDim2.fromOffset(pulseSize, pulseSize)
			local stroke = ring:FindFirstChildOfClass("UIStroke") :: UIStroke
			stroke.Transparency = pulseTrans
			stroke.Color = inc.colour or Color3.fromRGB(255, 140, 40)
		end

		local wx, wz = inc.x - p.X, inc.z - p.Z
		local sx = (wx * rx + wz * rz) * scale
		local sy = (wx * bx + wz * bz) * scale

		-- CLAMPED TO THE RIM rather than hidden, so an incident off the map still
		-- says which way to drive. On a circle that is one division: scale the
		-- ray down to the radius if it is longer than it.
		local R = VIEW / 2 - 7
		local d = math.sqrt(sx * sx + sy * sy)
		local clamped = d > R
		if clamped then
			sx, sy = sx / d * R, sy / d * R
		end
		f.Position = UDim2.fromOffset(VIEW / 2 + sx, VIEW / 2 + sy)

		-- THE DISTANCE, and only once the dot itself has stopped saying it --
		-- a pointer clamped to the rim has thrown away how far off the edge
		-- the real thing is, which is exactly the number worth putting back.
		local distLabel = f:FindFirstChild("Dist") :: TextLabel
		distLabel.Visible = clamped
		if clamped then
			local trueD = math.sqrt(wx * wx + wz * wz)
			distLabel.Text = ("%d m"):format(math.floor(trueD / 3))
		end
	end
	for i = n + 1, #blips do
		blips[i].Visible = false
	end

	-- ---- the objective arrow ----
	local target = ClientBus.myIncident
	if not target then
		arrow.Visible = false
	else
		local worldPos = Vector3.new(target.x, p.Y + 6 * 3, target.z)
		local screenPos, onScreen = camera:WorldToViewportPoint(worldPos)
		local viewport = camera.ViewportSize
		local cx, cy = viewport.X / 2, viewport.Y / 2
		local ax, ay = screenPos.X - cx, screenPos.Y - cy
		-- BEHIND THE CAMERA, WorldToViewportPoint still gives a screen
		-- position, but it is the MIRROR of where the point actually is --
		-- the projection does not know "behind" from "in front" on its own,
		-- only Z tells you that. Flip the offset back the right way round so
		-- the arrow still points at the real thing rather than its own
		-- reflection through the screen's centre.
		if screenPos.Z < 0 then
			ax, ay = -ax, -ay
		end
		if onScreen and screenPos.Z > 0 then
			-- Already on screen: the thing itself is the pointer.
			arrow.Visible = false
		else
			arrow.Visible = true
			local mx, my = cx - ARROW_MARGIN, cy - ARROW_MARGIN
			local scale = math.min(
				if math.abs(ax) > 1e-3 then mx / math.abs(ax) else math.huge,
				if math.abs(ay) > 1e-3 then my / math.abs(ay) else math.huge
			)
			if scale < 1 then
				ax, ay = ax * scale, ay * scale
			end
			arrow.Position = UDim2.fromOffset(cx + ax, cy + ay)
			-- The glyph points up at Rotation 0; this is the clockwise angle
			-- from up to the direction the arrow is actually sitting at.
			arrow.Rotation = math.deg(math.atan2(ax, -ay))
			local trueD = (Vector2.new(target.x, target.z) - Vector2.new(p.X, p.Z)).Magnitude
			arrowDist.Text = ("%d m"):format(math.floor(trueD / 3))
		end
	end
end)
