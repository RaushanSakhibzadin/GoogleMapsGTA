--!strict
-- THE LOADING SCREEN, and the reason there has to be one.
--
-- Reported plainly: "the car does not exist at the beginning - it is not loaded
-- yet". That is exactly right, and it is not one wait but three that have to
-- finish before the game is playable:
--
--   1. the SERVER lays down ~57,000 collision boxes on a frame budget
--   2. the CLIENT builds the first ring of city chunks, ~40,000 parts
--   3. the server spawns your car and replicates it
--
-- Until all three land there is nothing to drive and, worse, nothing to look
-- at: VehicleController returns early with no model, so it never takes the
-- camera, and Roblox leaves you looking at whatever the default camera found.
-- The old build simply showed you that.
--
-- IN ReplicatedFirst, WHICH IS THE POINT. Scripts here run before the rest of
-- ReplicatedStorage has replicated, so this is on screen while the things it is
-- waiting for are still arriving. Anywhere else and the loading screen would
-- itself be one of the things being waited for.
--
-- IT WATCHES THE CITY BUILD. The camera orbits the district centre looking in,
-- which is where the first chunks land -- so the progress bar has something
-- honest behind it rather than a spinner over a black screen. That is the whole
-- of the "cool" here: showing the real thing happening.
--
-- NOTHING BORROWED. No wordmark, palette, typeface or layout from any other
-- game -- this is VICE MAPS' own name in Roblox's own fonts. The attribution
-- line is not decoration either: a district derived from OpenStreetMap is a
-- derivative database and ODbL requires the credit to be visible inside the
-- experience (ROBLOX_PORT_PLAN.md R15). A loading screen everyone sees once is
-- the right place for it.

local ReplicatedFirst = game:GetService("ReplicatedFirst")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

-- PCALLED because it throws if the default screen has already gone -- which it
-- has, if this script is re-run in Studio without a fresh play session.
pcall(function()
	ReplicatedFirst:RemoveDefaultLoadingScreen()
end)

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

-- WAITED FOR. A script in ReplicatedFirst runs early enough that
-- workspace.CurrentCamera can still be nil -- the client creates it a moment
-- after the player joins -- and indexing it then is the kind of error that
-- kills the loading screen and leaves the black default one in its place.
local camera = workspace.CurrentCamera
while not camera do
	task.wait()
	camera = workspace.CurrentCamera
end

-- ---------------------------------------------------------------- the screen

local gui = Instance.new("ScreenGui")
gui.Name = "Loading"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
-- ABOVE EVERYTHING, including the dispatch card, which builds itself at about
-- the same moment and would otherwise be visible through the loading screen.
gui.DisplayOrder = 1000
gui.Parent = playerGui

local back = Instance.new("Frame")
back.Size = UDim2.fromScale(1, 1)
back.BackgroundColor3 = Color3.fromRGB(9, 10, 13)
back.BorderSizePixel = 0
back.Parent = gui

-- A wash of the city's own orange across the bottom, so the panel belongs to
-- this game rather than being a black rectangle.
local wash = Instance.new("Frame")
wash.Size = UDim2.new(1, 0, 0, 6)
wash.Position = UDim2.new(0, 0, 1, -6)
wash.BackgroundColor3 = Color3.fromRGB(255, 140, 40)
wash.BorderSizePixel = 0
wash.Parent = back

local function text(
	parent: Instance,
	size: UDim2,
	pos: UDim2,
	str: string,
	sz: number,
	font: Enum.Font,
	colour: Color3
): TextLabel
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Size = size
	t.Position = pos
	t.Font = font
	t.Text = str
	t.TextSize = sz
	t.TextColor3 = colour
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.Parent = parent
	return t
end

local title = text(
	back,
	UDim2.new(1, -96, 0, 64),
	UDim2.new(0, 48, 0.5, -96),
	"VICE MAPS",
	46,
	Enum.Font.GothamBlack,
	Color3.fromRGB(240, 242, 246)
)

local place = text(
	back,
	UDim2.new(1, -96, 0, 24),
	UDim2.new(0, 50, 0.5, -34),
	"PALILULA  ·  BEOGRAD",
	16,
	Enum.Font.GothamMedium,
	Color3.fromRGB(255, 140, 40)
)

-- The bar, and a number, because a bar alone does not tell you whether it is
-- stuck.
-- SIZED IN SCALE, not in pixels. 420 px of bar plus a 50 px margin runs off the
-- side of a phone held upright, and this is the one screen everybody sees.
local track = Instance.new("Frame")
track.Size = UDim2.new(0.42, 0, 0, 4)
track.Position = UDim2.new(0, 50, 0.5, 16)
track.BackgroundColor3 = Color3.fromRGB(38, 42, 50)
track.BorderSizePixel = 0
track.Parent = back

local fill = Instance.new("Frame")
fill.Size = UDim2.fromScale(0, 1)
fill.BackgroundColor3 = Color3.fromRGB(255, 140, 40)
fill.BorderSizePixel = 0
fill.Parent = track

local status = text(
	back,
	UDim2.new(0, 480, 0, 20),
	UDim2.new(0, 50, 0.5, 30),
	"Connecting…",
	14,
	Enum.Font.Gotham,
	Color3.fromRGB(150, 156, 166)
)

local pct = text(
	back,
	UDim2.new(0, 60, 0, 20),
	UDim2.new(0.42, 62, 0.5, 10),
	"0%",
	14,
	Enum.Font.GothamMedium,
	Color3.fromRGB(150, 156, 166)
)

local tip = text(
	back,
	UDim2.new(1, -96, 0, 20),
	UDim2.new(0, 48, 1, -70),
	"",
	14,
	Enum.Font.Gotham,
	Color3.fromRGB(120, 126, 136)
)

-- ODbL, and it stays on screen for the whole load rather than flashing past.
local credit = text(
	back,
	UDim2.new(1, -96, 0, 18),
	UDim2.new(0, 48, 1, -40),
	"Map data © OpenStreetMap contributors, ODbL",
	12,
	Enum.Font.Gotham,
	Color3.fromRGB(84, 90, 100)
)

-- Things worth knowing, shown one at a time. Every one of them is a real
-- control or a real fact about this build -- a loading screen is the only place
-- anybody reads instructions.
local TIPS = {
	"W A S D to drive  ·  SPACE for the handbrake",
	"E responds to the nearest job on the board",
	"The map in the corner turns with you — north is wherever you are pointing",
	"Off the tarmac you crawl. The roads are the real roads.",
	"A fire blinks while you are working it",
	"Every street here is where OpenStreetMap says it is",
	"Buildings are their real footprints at their real heights",
	"The city loads around you as you drive",
}
local tipAt = math.random(1, #TIPS)
tip.Text = TIPS[tipAt]

task.spawn(function()
	while gui.Parent do
		task.wait(3.5)
		tipAt = tipAt % #TIPS + 1
		tip.Text = TIPS[tipAt]
	end
end)

-- ---------------------------------------------------------------- the camera

-- ORBITING THE DISTRICT CENTRE, looking in and down. The first chunks the city
-- builds are the ones nearest the origin -- which is where the car spawns --
-- so this is pointed at exactly the thing that is arriving.
camera.CameraType = Enum.CameraType.Scriptable

-- THE FLAG THE REST OF THE CLIENT READS. VehicleController skips its whole
-- update while this is set: without it the car is being driven and the camera
-- fought over behind an opaque panel, and the player arrives somewhere other
-- than where they spawned because they were leaning on W during the load.
--
-- It is cleared before the fade rather than after, and the clear is the first
-- thing past the waits below -- a loading screen that errors on its way out
-- must not leave the car frozen for ever.
workspace:SetAttribute("Loading", true)

local ORBIT_R = 900 -- studs out
local ORBIT_H = 420 -- studs up
local ORBIT_SPEED = 0.09 -- radians a second: slow enough to read as deliberate
local orbit = math.random() * math.pi * 2
local ownCamera = true

-- ---------------------------------------------------------------- readiness

-- Three things, weighted by roughly how long each takes. The weights only have
-- to be honest enough that the bar does not sit at 90% for most of the wait.
local W_COLLISION, W_CITY, W_CAR = 0.25, 0.55, 0.20

local function carHere(): boolean
	local cars = workspace:FindFirstChild("Cars")
	if not cars then
		return false
	end
	for _, m in cars:GetChildren() do
		if m:IsA("Model") and m:GetAttribute("Owner") == player.UserId then
			return true
		end
	end
	return false
end

-- Both of these are set as attributes on Workspace by the things that do the
-- work -- BuildCity on the server and CityVisuals on this client. Attributes
-- rather than remotes because there is nothing to negotiate: it is one bit and
-- one number, and a late joiner reads the current value rather than having
-- missed the event.
local function collisionDone(): boolean
	return workspace:GetAttribute("CollisionReady") == true
end

local function cityFraction(): number
	local want = workspace:GetAttribute("CityRingWanted")
	local got = workspace:GetAttribute("CityRingBuilt")
	if type(want) ~= "number" or want <= 0 then
		return 0
	end
	if type(got) ~= "number" then
		return 0
	end
	return math.clamp(got / want, 0, 1)
end

local shown = 0 -- the bar's own value, eased, so it never jumps or goes back

RunService.RenderStepped:Connect(function(dt)
	if not gui.Parent then
		return
	end

	if ownCamera then
		orbit += ORBIT_SPEED * dt
		local eye = Vector3.new(math.cos(orbit) * ORBIT_R, ORBIT_H, math.sin(orbit) * ORBIT_R)
		camera.CFrame = CFrame.lookAt(eye, Vector3.new(0, 40, 0))
	end

	local col = if collisionDone() then 1 else 0
	local city = cityFraction()
	local car = if carHere() then 1 else 0

	local target = col * W_COLLISION + city * W_CITY + car * W_CAR

	-- EASED, AND MONOTONIC. The three parts finish out of order and the city
	-- fraction can wobble as chunks are counted, and a bar that goes backwards
	-- looks broken even when nothing is wrong.
	shown = math.max(shown, shown + (target - shown) * math.min(dt * 4, 1))
	fill.Size = UDim2.fromScale(shown, 1)
	pct.Text = ("%d%%"):format(math.floor(shown * 100 + 0.5))

	if col < 1 then
		status.Text = "Laying out the city…"
	elseif city < 1 then
		status.Text = ("Building Palilula…  %d%%"):format(math.floor(city * 100 + 0.5))
	elseif car < 1 then
		status.Text = "Bringing your vehicle round…"
	else
		status.Text = "Ready"
	end
end)

-- ---------------------------------------------------------------- the handover

task.spawn(function()
	-- A FLOOR ON HOW LONG IT SHOWS. On a warm client all three of these can be
	-- true within a second, and a loading screen that flashes past is worse than
	-- none -- you see a flicker and cannot read a word of it.
	local opened = os.clock()

	-- AND A CEILING ON IT, because a loading screen that can wait forever is the
	-- worst failure mode this could have: if CityVisuals throws, or the car never
	-- reaches this client, the player sits looking at a bar at 74% with no way to
	-- tell whether anything is wrong. Better to let them in with a warning in the
	-- log naming exactly what never arrived.
	--
	-- Thirty seconds, against a cold join measured at about five: collision 4.6 s
	-- and the first ring of city 3.1 s, in parallel. Six times the real cost is
	-- generous; a minute was just a long time to stare at a stuck bar.
	local GIVE_UP = 30
	while not (collisionDone() and cityFraction() >= 1 and carHere()) do
		if os.clock() - opened > GIVE_UP then
			warn(
				("[loading] giving up after %ds -- collision %s, city %.0f%%, car %s. "):format(
					GIVE_UP,
					tostring(collisionDone()),
					cityFraction() * 100,
					tostring(carHere())
				) .. "Letting the player in anyway; something above did not finish."
			)
			break
		end
		task.wait(0.1)
	end
	while os.clock() - opened < 2.5 do
		task.wait(0.1)
	end
	-- And let the bar visibly reach the end rather than cutting it off at 96% --
	-- but not for ever, since the give-up path above can arrive here with the
	-- bar genuinely short of full.
	local settle = os.clock()
	while shown < 0.99 and os.clock() - settle < 2 do
		task.wait(0.05)
	end

	-- RELEASED FIRST, AND UNCONDITIONALLY. Everything below is cosmetic; if any
	-- of it throws, the player must still end up in a car they can drive with a
	-- camera behind it.
	ownCamera = false
	workspace:SetAttribute("Loading", false)

	pcall(function()
		local out = TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
		for _, item in { back, wash, title, place, track, fill, status, pct, tip, credit } do
			local goal = if item:IsA("TextLabel")
				then { TextTransparency = 1 }
				else { BackgroundTransparency = 1 }
			TweenService:Create(item, out, goal):Play()
		end
	end)
	task.wait(0.7)
	gui:Destroy()
end)
