--!strict
-- DAY AND DUSK, js/util.js THEMES -- two switchable looks, not a continuous
-- cycle, because that is what the browser actually has: pressing N or
-- tapping the theme button flips between exactly two themes (js/io.js:19-34),
-- day and dusk, and nothing in between is ever drawn.
--
-- ROBLOX'S OWN LIGHTING DOES THE WORK js/util.js:THEMES.wallT/roofT FAKED PER
-- PIXEL. The browser has to manually re-tint every building on a theme
-- change -- "thousands of buildings in a few ms" is its own comment on the
-- cost -- because a canvas has no lighting model of its own; whatever colour
-- a wall is drawn is the colour it stays until something redraws it. Roblox
-- already relights every already-baked Part live off ClockTime/Ambient, so
-- there is nothing here to iterate over except the lamps, which is the one
-- thing a change in Lighting cannot reach on its own.
--
-- THE VALUES ARE NOT THE BROWSER'S OWN COLOUR STRINGS. THEMES.dusk/day are
-- flat fill colours for a 2D/pseudo-3D renderer with no sun of its own; the
-- equivalent question for a real lit scene is "what time is it and how dark
-- is the ambient", not "what hex code is the road". Chosen to land close to
-- the browser's OWN readable intent -- day bright and near-neutral, dusk dim
-- and pulled violet, the same pull THEMES.dusk's wallT mixes towards
-- ([54, 36, 78]) -- rather than to match a screenshot pixel for pixel.

local Lighting = game:GetService("Lighting")
local UserInputService = game:GetService("UserInputService")

type Preset = {
	ClockTime: number,
	Brightness: number,
	Ambient: Color3,
	OutdoorAmbient: Color3,
	FogEnd: number,
	FogColor: Color3,
}

local DAY: Preset = {
	ClockTime = 14,
	Brightness = 2,
	Ambient = Color3.fromRGB(120, 120, 130),
	OutdoorAmbient = Color3.fromRGB(150, 150, 160),
	FogEnd = 3000,
	FogColor = Color3.fromRGB(180, 190, 200),
}

local DUSK: Preset = {
	ClockTime = 20.5,
	Brightness = 0.6,
	Ambient = Color3.fromRGB(30, 26, 46),
	OutdoorAmbient = Color3.fromRGB(46, 40, 66),
	FogEnd = 900,
	FogColor = Color3.fromRGB(18, 14, 30),
}

local isDusk = false

local function apply(p: Preset)
	Lighting.ClockTime = p.ClockTime
	Lighting.Brightness = p.Brightness
	Lighting.Ambient = p.Ambient
	Lighting.OutdoorAmbient = p.OutdoorAmbient
	Lighting.FogEnd = p.FogEnd
	Lighting.FogColor = p.FogColor
end

apply(DAY)
workspace:SetAttribute("Dusk", false)

-- WALKED ONCE A TOGGLE, not every frame -- a lamp itself already reads
-- workspace:GetAttribute("Dusk") at the moment CityParts.lights builds it
-- (CityVisuals.client.luau), so this is only for the lamps already standing
-- when the key is pressed. Named, not typed, so a lamp's own PointLight is
-- found by what it is rather than by trusting nothing else in the city is
-- ever named the same thing.
local function relight(lit: boolean)
	local city = workspace:FindFirstChild("City")
	if not city then
		return
	end
	for _, d in city:GetDescendants() do
		if d:IsA("PointLight") and d.Name == "LampLight" then
			d.Enabled = lit
		end
	end
end

local function toggle()
	isDusk = not isDusk
	apply(if isDusk then DUSK else DAY)
	workspace:SetAttribute("Dusk", isDusk)
	relight(isDusk)
end

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.N then
		toggle()
	end
end)
