import { createHash, randomUUID } from "node:crypto";
import type { Customer, HoldResult } from "./bookingStore";

type HoldOptions = {
  poolDayKey?: string;
  units?: number;
  orderDraftKey?: string;
  bookingMode?: "private" | "shared";
  poolKey?: string;
  date?: string;
  capacityUnits?: number;
};
type Client = { eval(script: string, count: number, ...args: string[]): Promise<unknown> };

const CREATE = `
local hold=cjson.decode(ARGV[1])
local ttl=tonumber(ARGV[2])
local capacity=tonumber(ARGV[3])
local private=ARGV[4]=='private'
local hasRequest=ARGV[5]=='1'
for _,i in ipairs({1,2,6,7,8,9}) do
  local t=redis.call('TYPE',KEYS[i]).ok
  if t~='none' and t~='string' then return redis.error_reply('invalid hold string key') end
end
for _,i in ipairs({3,4,5}) do
  local t=redis.call('TYPE',KEYS[i]).ok
  if t~='none' and t~='set' then return redis.error_reply('invalid hold index') end
end
if hasRequest then
  local priorId=redis.call('GET',KEYS[2])
  if priorId then
    local priorRaw=redis.call('GET','hold:'..priorId)
    if priorRaw then
      local prior=cjson.decode(priorRaw)
      if prior.holdId~=priorId or redis.call('PTTL','hold:'..priorId)<=0 then return redis.error_reply('invalid prior hold') end
      if prior.requestFingerprint then
        if prior.requestFingerprint~=hold.requestFingerprint then return redis.error_reply('request identity mismatch') end
      else
        if prior.slotKey~=hold.slotKey or prior.poolDayKey~=hold.poolDayKey or prior.pax~=hold.pax or prior.units~=hold.units
          or prior.orderDraftKey~=hold.orderDraftKey or type(prior.customer)~='table' then return redis.error_reply('request identity mismatch') end
        for _,field in ipairs({'name','phone','email'}) do
          if prior.customer[field]~=hold.customer[field] then return redis.error_reply('request identity mismatch') end
        end
      end
      if redis.call('SISMEMBER',KEYS[3],priorId)~=1 then return redis.error_reply('incomplete prior index') end
      if private then
        if redis.call('GET',KEYS[6])~=priorId then return redis.error_reply('incomplete prior lock') end
      elseif redis.call('SISMEMBER',KEYS[4],priorId)~=1 then return redis.error_reply('incomplete prior pool') end
      return {priorId,prior.expiresAt}
    end
  end
end
if redis.call('EXISTS',KEYS[1])~=0 then return redis.error_reply('hold ID collision') end
local stale={}
local function active(index,byPool)
  if redis.call('SCARD',KEYS[index])>2000 then error('hold index requires reconciliation') end
  local units=0
  for _,id in ipairs(redis.call('SMEMBERS',KEYS[index])) do
    local raw=redis.call('GET','hold:'..id)
    if raw then
      local item=cjson.decode(raw)
      if item.holdId~=id or type(item.units)~='number' or item.units<1 or item.units%1~=0 or
        item.units>9007199254740991 or redis.call('PTTL','hold:'..id)<=0 then error('invalid active hold') end
      if byPool then
        if item.poolDayKey~=hold.poolDayKey then error('mismatched pool index') end
      elseif item.slotKey~=hold.slotKey and item.slotKey~=ARGV[6] then error('mismatched slot index') end
      units=units+item.units
      if units>9007199254740991 then error('invalid hold sum') end
    else table.insert(stale,{KEYS[index],id}) end
  end
  return units
end
if private then
  local flag=redis.call('GET',KEYS[7])
  if flag and flag~='1' then return redis.error_reply('invalid confirmed flag') end
  if flag=='1' or redis.call('GET',KEYS[6]) or active(3,false)>0 or active(5,false)>0 then return 'UNAVAILABLE' end
else
  local raw=redis.call('GET',KEYS[8]) or '0'
  if raw~='0' and not string.match(raw,'^[1-9]%d*$') then return redis.error_reply('invalid confirmed pool') end
  local confirmed=tonumber(raw)
  if not confirmed or confirmed>9007199254740991 then return redis.error_reply('invalid confirmed pool') end
  if confirmed+active(4,true)+hold.units>capacity then return 'UNAVAILABLE' end
end
local slotRaw=redis.call('GET',KEYS[9])
local slot={capacity=20,remaining=20}
if slotRaw then slot=cjson.decode(slotRaw) end
if type(slot)~='table' or type(slot.capacity)~='number' or type(slot.remaining)~='number' or
  slot.capacity<0 or slot.capacity%1~=0 or slot.capacity>9007199254740991 or
  slot.remaining<0 or slot.remaining%1~=0 or slot.remaining>slot.capacity then return redis.error_reply('invalid legacy slot') end
slot.remaining=math.max(0,slot.remaining-hold.pax)
local slotJson=cjson.encode(slot)
local slotTTL=redis.call('PTTL',KEYS[3])
local poolTTL=redis.call('PTTL',KEYS[4])
redis.call('SET',KEYS[1],ARGV[1],'PX',ttl)
redis.call('SADD',KEYS[3],hold.holdId)
if slotTTL~=-1 then redis.call('PEXPIRE',KEYS[3],math.max(ttl,slotTTL)) end
if not private then
  redis.call('SADD',KEYS[4],hold.holdId)
  if poolTTL~=-1 then redis.call('PEXPIRE',KEYS[4],math.max(ttl,poolTTL)) end
else redis.call('SET',KEYS[6],hold.holdId,'PX',ttl) end
if hasRequest then redis.call('SET',KEYS[2],hold.holdId,'PX',ttl) end
redis.call('SET',KEYS[9],slotJson)
for _,entry in ipairs(stale) do redis.call('SREM',entry[1],entry[2]) end
return {hold.holdId,hold.expiresAt}
`;

/** Capacity check and hold publication are one Redis operation. No automatic
 * retry after a lost response; a deliberate repeat with the same request ID
 * returns the same matching, still-live hold without extending its TTL. */
export async function createRedisBookingHold(
  client: Client,
  slotKey: string,
  pax: number,
  customer: Customer,
  clientRequestId: string | undefined,
  options: HoldOptions | undefined,
): Promise<HoldResult> {
  let result: unknown;
  try {
    const mode = options?.bookingMode,
      units = options?.units;
    const date = options?.date,
      pool = options?.poolKey;
    const ttl = process.env.HOLD_TTL_SEC === undefined ? 600 : Number(process.env.HOLD_TTL_SEC);
    if (
      !options ||
      !["private", "shared"].includes(mode!) ||
      !date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !pool ||
      !slotKey.endsWith(`|${date}`) ||
      slotKey.length > 500 ||
      !Number.isSafeInteger(pax) ||
      pax < 1 ||
      pax > 20 ||
      !Number.isSafeInteger(units) ||
      units! < 1 ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 86400 ||
      !customer ||
      typeof customer.name !== "string" ||
      (clientRequestId !== undefined && (!clientRequestId || clientRequestId.length > 200))
    ) {
      throw new Error();
    }
    const product = slotKey.slice(0, -date.length - 1);
    if (!product || product.includes("|")) {
      throw new Error();
    }
    if (
      mode === "shared" &&
      (options.poolDayKey !== `${pool}|${date}` ||
        !Number.isSafeInteger(options.capacityUnits) ||
        options.capacityUnits! < 1)
    ) {
      throw new Error();
    }
    if (mode === "private" && options.poolDayKey !== undefined) {
      throw new Error();
    }
    const holdId = `hold_${randomUUID()}`,
      now = new Date();
    const canonical = [
      slotKey,
      pax,
      customer.name,
      customer.phone ?? null,
      customer.email ?? null,
      mode,
      options.poolDayKey ?? null,
      units,
      options.orderDraftKey ?? null,
    ];
    const hold = {
      holdId,
      slotKey,
      poolDayKey: mode === "shared" ? options.poolDayKey : undefined,
      pax,
      units,
      customer,
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      createdAt: now.toISOString(),
      idempotencyKey: clientRequestId,
      orderDraftKey: options.orderDraftKey,
      requestFingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    };
    const slotIndex = `hold:slot:${slotKey}`,
      legacySlot = `slot:${product}:${date}::`;
    const keys = [
      `hold:${holdId}`,
      clientRequestId ? `idempo:${clientRequestId}` : `hold:${holdId}`,
      slotIndex,
      mode === "shared" ? `hold:pool:${options.poolDayKey}` : slotIndex,
      `hold:slot:${legacySlot}`,
      `lock:slot:${slotKey}`,
      `confirmed:${slotKey}`,
      `pool:${pool}|${date}`,
      `slot:${slotKey}`,
    ];
    result = await client.eval(
      CREATE,
      keys.length,
      ...keys,
      JSON.stringify(hold),
      String(ttl * 1000),
      String(options.capacityUnits ?? 1),
      mode!,
      clientRequestId ? "1" : "0",
      legacySlot,
    );
    if (
      result !== "UNAVAILABLE" &&
      (!Array.isArray(result) ||
        result.length !== 2 ||
        typeof result[0] !== "string" ||
        typeof result[1] !== "string" ||
        !Number.isFinite(Date.parse(result[1])))
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Booking hold creation requires reconciliation");
  }
  if (result === "UNAVAILABLE") {
    throw new Error("BOOKING_NOT_AVAILABLE");
  }
  const [holdId, expiresAt] = result as [string, string];
  return { holdId, expiresAt };
}
