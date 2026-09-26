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
	-- THE GRADE, which is the other half of a look and was missing entirely.
	-- Exposure and saturation are what separate a lit scene from a
	-- photographed one, and Roblox puts both behind post-effects rather than
	-- behind Lighting properties -- so they travel with the preset instead of
	-- being set once and left to fight it.
	Exposure: number,
	Saturation: number,
	Contrast: number,
	Tint: Color3,
	Bloom: number,
}

-- DAY IS A SUNNY DAY NOW, not an overcast one.
--
-- The old values were honest and grey: ClockTime 14, a neutral ambient, and
-- nothing at all in post. That reads as a city under cloud, which is not what
-- either game looks like -- the browser's own day theme is bright and saturated
-- and the shadows in it are hard.
--
-- What changed and why:
--   · ClockTime 13.4 rather than 14 -- barely moved, but it is the sun's angle
--     and a sun nearer the zenith throws the short hard shadows this look wants
--   · a WARM sun against a COOL ambient, which is what makes a lit face read as
--     lit; a neutral ambient of the same colour as the key light flattens
--     everything it touches
--   · saturation up a quarter. The city is built from flat Parts in flat
--     colours and flat colour desaturates on screen far more than a textured
--     surface does
--   · fog pulled in from 3000 to 1800 and tinted towards the sky, so the far
--     edge of the district fades into the horizon instead of ending in mid-air
local DAY: Preset = {
	ClockTime = 13.4,
	Brightness = 2.6,
	Ambient = Color3.fromRGB(116, 124, 146),
	OutdoorAmbient = Color3.fromRGB(150, 162, 188),
	FogEnd = 1800,
	FogColor = Color3.fromRGB(196, 210, 232),
	Exposure = 0.12,
	Saturation = 0.24,
	Contrast = 0.08,
	Tint = Color3.fromRGB(255, 252, 246),
	Bloom = 0.9,
}

local DUSK: Preset = {
	ClockTime = 20.5,
	Brightness = 0.6,
	Ambient = Color3.fromRGB(30, 26, 46),
	OutdoorAmbient = Color3.fromRGB(46, 40, 66),
	FogEnd = 900,
	FogColor = Color3.fromRGB(18, 14, 30),
	-- Dusk keeps its own grade rather than borrowing day's: the point of the
	-- violet pull is that it is dim and cool, and day's exposure lift would
	-- undo exactly that.
	Exposure = -0.05,
	Saturation = 0.1,
	Contrast = 0.12,
	Tint = Color3.fromRGB(236, 232, 255),
	Bloom = 1.6,
}

local isDusk = false

-- MADE ONCE, REUSED, AND FOUND BY NAME IF IT IS ALREADY THERE. A published
-- place can have these effects saved into Lighting from Studio; making a second
-- set would stack two grades on top of each other and blow the picture out.
local function effect(class: string, name: string): Instance
	local found = Lighting:FindFirstChild(name)
	if found and found.ClassName == class then
		return found
	end
	if found then
		found:Destroy()
	end
	local made = Instance.new(class)
	made.Name = name
	made.Parent = Lighting
	return made
end

local grade = effect("ColorCorrectionEffect", "Grade") :: ColorCorrectionEffect
local bloom = effect("BloomEffect", "Glow") :: BloomEffect
bloom.Threshold = 1.1
bloom.Size = 24

-- THE SUN'S OWN COLOUR IS NOT A PRESET FIELD because it does not change between
-- the two: a warm key against a cool ambient is the look, and dusk's own
-- darkness comes from Brightness and Ambient rather than from tinting the sun
-- a different colour every toggle.
Lighting.ColorShift_Top = Color3.fromRGB(255, 244, 222)
Lighting.GlobalShadows = true
Lighting.EnvironmentDiffuseScale = 0.45
Lighting.EnvironmentSpecularScale = 0.35

local function apply(p: Preset)
	Lighting.ClockTime = p.ClockTime
	Lighting.Brightness = p.Brightness
	Lighting.Ambient = p.Ambient
	Lighting.OutdoorAmbient = p.OutdoorAmbient
	Lighting.FogEnd = p.FogEnd
	Lighting.FogColor = p.FogColor
	Lighting.ExposureCompensation = p.Exposure

	grade.Saturation = p.Saturation
	grade.Contrast = p.Contrast
	grade.TintColor = p.Tint
	grade.Brightness = 0
	bloom.Intensity = p.Bloom
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
