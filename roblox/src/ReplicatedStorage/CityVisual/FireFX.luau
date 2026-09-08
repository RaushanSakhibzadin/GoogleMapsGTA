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

export type Rig = {
	model: Model,
	seat: BasePart, -- the burning thing itself
	fire: Fire,
	smoke: Smoke,
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

function FireFX.new(parent: Instance): Rig
	local model = Instance.new("Model")
	model.Name = "Fire"

	-- THE SEAT IS INVISIBLE. Fire and Smoke are drawn ON a part, at its size,
	-- and the part underneath would otherwise be a grey box sitting in the
	-- middle of the flames.
	local seat = part("Seat", model)
	seat.Transparency = 1
	seat.Size = Vector3.new(10, 10, 10)

	local fire = Instance.new("Fire")
	fire.Heat = 16
	fire.Size = 18
	fire.Color = FLAME_COOL
	fire.SecondaryColor = FLAME_HOT
	fire.Parent = seat

	local smoke = Instance.new("Smoke")
	smoke.Color = Color3.fromRGB(38, 36, 34)
	smoke.Opacity = 0.28
	smoke.RiseVelocity = 14
	smoke.Size = 26
	smoke.Parent = seat

	-- Light does most of the work at night and a surprising amount by day: it is
	-- what makes the wall behind the fire look lit rather than painted.
	local light = Instance.new("PointLight")
	light.Color = Color3.fromRGB(255, 148, 60)
	light.Range = 46
	light.Brightness = 2.4
	light.Shadows = false
	light.Parent = seat

	-- A GLOW AT THE BASE, because Fire is drawn as a billboard and vanishes edge
	-- on. A neon slab under it means there is always something burning-coloured
	-- where the fire is, from any angle.
	local glow = part("Glow", model)
	glow.Material = Enum.Material.Neon
	glow.Color = FLAME_COOL
	glow.Transparency = 0.25
	glow.Size = Vector3.new(11, 1.5, 11)

	-- And the column you navigate by, which is what this used to be all of.
	local beacon = part("Beacon", model)
	beacon.Material = Enum.Material.Neon
	beacon.Color = Color3.fromRGB(255, 140, 40)
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
	rig.fire.Size = math.clamp(18 * scale * blink, 2, 30)
	rig.fire.Heat = math.clamp(16 * scale, 1, 25)
	-- Whiter at full strength, redder as it dies.
	rig.fire.Color = FLAME_COOL:Lerp(FLAME_HOT, left * 0.5)

	rig.smoke.Size = math.clamp(26 * scale, 1, 100)
	rig.smoke.Opacity = 0.28 * left
	rig.smoke.Enabled = left > 0.05

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
