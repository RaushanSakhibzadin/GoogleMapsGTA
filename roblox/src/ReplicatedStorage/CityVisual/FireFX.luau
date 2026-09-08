--!strict
-- A BUILDING ON FIRE, and what it does while you are putting it out.
--
-- The incident used to be a 400-stud orange column and nothing else: you could
-- find it, and standing at it looked exactly like standing anywhere else. This
-- is the fire itself -- flame, glow, smoke and a beacon over the top of it --
-- and the state of the job is readable from the fire rather than only from the
-- card in the corner.
--
-- NO ASSETS, AGAIN. `Fire` and `Smoke` are Instances the engine draws itself:
-- no texture id, no upload, no moderation, and they were in Roblox before
-- ParticleEmitter was. That is the whole reason they are used here rather than
-- a particle emitter with a texture on it -- see Shared/Audio for the same
-- constraint hit from the other direction.
--
-- WHAT IT SAYS, at a glance:
--
--   idle          steady flame, steady beacon. A job nobody is on.
--   being fought  THE WHOLE THING BLINKS, fast, and the beacon strobes with it.
--   nearly out    flame shrinks with progress, light dims, smoke thins.
--
-- The blink is the thing that was asked for and it is deliberately not subtle:
-- it is the difference between "I have arrived" and "I am doing the job", which
-- are otherwise the same picture.

local FireFX = {}

-- AND NOT EVERY INCIDENT IS ON FIRE. Once there is more than one kind on the
-- board -- a road collision, a medical call, a fare -- the flame stops being
-- decoration and starts being a lie: it is the one glance that tells a
-- firefighter this job is theirs. So the flame is optional and the beacon is
-- not, and a rig without one is the same column, glow and light in the kind's
-- own colour with nothing burning inside it.
export type Rig = {
	model: Model,
	seat: BasePart, -- the burning thing itself
	fire: Fire?,
	smoke: Smoke?,
	light: PointLight,
	beacon: BasePart,
	glow: BasePart,
}

local FLAME_HOT = Color3.fromRGB(255, 214, 130)
local FLAME_COOL = Color3.fromRGB(255, 96, 24)

-- ---------------------------------------------------------------- building it

local function part(name: string, parent: Instance): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = false
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Parent = parent
	return p
end

-- `burning` builds the flame and the smoke; `tint` is the colour of everything
-- that is not the flame. Both default to the structure fire this started as, so
-- an old call site is unchanged.
function FireFX.new(parent: Instance, burning: boolean?, tint: Color3?): Rig
	local model = Instance.new("Model")
	model.Name = "Incident"

	local alight = burning ~= false
	local colour = tint or Color3.fromRGB(255, 140, 40)

	-- THE SEAT IS INVISIBLE. Fire and Smoke are drawn ON a part, at its size,
	-- and the part underneath would otherwise be a grey box sitting in the
	-- middle of the flames.
	local seat = part("Seat", model)
	seat.Transparency = 1
	seat.Size = Vector3.new(10, 10, 10)

	local fire: Fire? = nil
	local smoke: Smoke? = nil
	if alight then
		local f = Instance.new("Fire")
		f.Heat = 16
		f.Size = 18
		f.Color = FLAME_COOL
		f.SecondaryColor = FLAME_HOT
		f.Parent = seat
		fire = f

		local s = Instance.new("Smoke")
		s.Color = Color3.fromRGB(38, 36, 34)
		s.Opacity = 0.28
		s.RiseVelocity = 14
		s.Size = 26
		s.Parent = seat
		smoke = s
	end

	-- Light does most of the work at night and a surprising amount by day: it is
	-- what makes the wall behind the fire look lit rather than painted.
	local light = Instance.new("PointLight")
	light.Color = if alight then Color3.fromRGB(255, 148, 60) else colour
	light.Range = 46
	light.Brightness = 2.4
	light.Shadows = false
	light.Parent = seat

	-- A GLOW AT THE BASE, because Fire is drawn as a billboard and vanishes edge
	-- on. A neon slab under it means there is always something burning-coloured
	-- where the fire is, from any angle.
	local glow = part("Glow", model)
	glow.Material = Enum.Material.Neon
	glow.Color = if alight then FLAME_COOL else colour
	glow.Transparency = 0.25
	glow.Size = Vector3.new(11, 1.5, 11)

	-- And the column you navigate by, which is what this used to be all of.
	local beacon = part("Beacon", model)
	beacon.Material = Enum.Material.Neon
	beacon.Color = colour
	beacon.Transparency = 0.55
	beacon.Size = Vector3.new(5, 400, 5)

	model.Parent = parent
	return {
		model = model,
		seat = seat,
		fire = fire,
		smoke = smoke,
		light = light,
		beacon = beacon,
		glow = glow,
	}
end

-- ---------------------------------------------------------------- driving it

-- `progress` is 0..1 of the work done. `fought` is whether the local player is
-- on scene working it. `t` is any monotonically rising time -- the blink phase
-- comes out of it, so passing os.clock() is fine and passing a per-fire clock
-- would make every fire on the map blink out of step, which is nicer still.
function FireFX.update(rig: Rig, x: number, z: number, progress: number, fought: boolean, t: number)
	local left = math.clamp(1 - progress, 0, 1)

	-- DYING DOWN AS THE WORK GETS DONE. Not linear: a fire that is 80% out
	-- should still look like a fire, so the size follows a curve that stays big
	-- and then drops away at the end.
	local scale = 0.25 + 0.75 * left ^ 0.6

	-- THE BLINK. A hard square-ish pulse rather than a sine, because a smooth
	-- swell reads as flicker -- which is what a fire does anyway -- and the
	-- point of this is to read as deliberate. Roughly five a second.
	local blink = 1
	if fought then
		blink = if math.sin(t * 31) > 0 then 1.55 else 0.5
	end

	rig.seat.CFrame = CFrame.new(x, 6, z)
	rig.seat.Size = Vector3.new(10 * scale, 10 * scale, 10 * scale)

	-- CLAMPED, because Fire.Size tops out at 30 and Heat at 25 -- and a value
	-- over the cap is silently clamped, which would eat the bright half of the
	-- blink at full strength and leave it looking like a one-way flicker. Base
	-- 18 x the 1.55 bright phase is 27.9, comfortably under.
	if rig.fire then
		local f = rig.fire :: Fire
		f.Size = math.clamp(18 * scale * blink, 2, 30)
		f.Heat = math.clamp(16 * scale, 1, 25)
		-- Whiter at full strength, redder as it dies.
		f.Color = FLAME_COOL:Lerp(FLAME_HOT, left * 0.5)
	end

	if rig.smoke then
		local s = rig.smoke :: Smoke
		s.Size = math.clamp(26 * scale, 1, 100)
		s.Opacity = 0.28 * left
		s.Enabled = left > 0.05
	end

	rig.light.Brightness = 2.4 * scale * blink
	rig.light.Range = math.clamp(46 * scale, 4, 60)

	rig.glow.CFrame = CFrame.new(x, 0.8, z)
	rig.glow.Size = Vector3.new(11 * scale, 1.5, 11 * scale)
	rig.glow.Transparency = 1 - (0.75 * left * math.min(blink, 1.2))

	rig.beacon.CFrame = CFrame.new(x, 200, z)
	-- The beacon strobes WITH the fire rather than on its own phase, so the
	-- column and the flames read as one thing rather than two.
	rig.beacon.Transparency = if fought
		then (if blink > 1 then 0.3 else 0.8)
		else 0.55
end

function FireFX.destroy(rig: Rig)
	rig.model:Destroy()
end

return FireFX
