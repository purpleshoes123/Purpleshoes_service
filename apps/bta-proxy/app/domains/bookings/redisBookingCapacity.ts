import { BookingCapacityConflict } from "./bookingCapacityConflict";

/** Only the legacy confirmed-capacity projection. The caller must persist its
 * booking intent first and treat ANY uncertain result as requiring recovery. */
type Confirmation = {
  shop: string;
  orderId: string;
  lineItemId: string;
  groupKey?: string;
  slotKey: string;
  productId: string;
  date: string;
  bookingMode: string;
  poolKey: string;
  guideUnitsRequired: number;
};
export type ConfirmationCapacity = { capacityUnits: number | null; holdId?: string };
const CONFIRM = `
local function kind(key) return redis.call('TYPE',key).ok end
for _,i in ipairs({1,2,3,4,8}) do local t=kind(KEYS[i]) if t~='none' and t~='string' then return redis.error_reply('invalid capacity key type') end end
for _,i in ipairs({5,6,7}) do local t=kind(KEYS[i]) if t~='none' and t~='set' then return redis.error_reply('invalid hold index type') end end
local desired=cjson.decode(ARGV[1])
local flag=redis.call('GET',KEYS[2])
if flag and flag~='1' then return redis.error_reply('invalid slot flag') end
local raw=redis.call('GET',KEYS[3]) or '0'
if raw~='0' and not string.match(raw,'^[1-9]%d*$') then return redis.error_reply('invalid pool counter') end
local count=tonumber(raw)
local units=tonumber(ARGV[2])
if not count or not units or units<1 or units%1~=0 or count>9007199254740991 then return redis.error_reply('invalid pool sum') end
local ownId=ARGV[4]
local own=nil
local function validateHold(raw,id)
  local value=cjson.decode(raw)
  if type(value)~='table' or value.holdId~=id or type(value.units)~='number' or value.units<1 or value.units%1~=0 or
    value.units>9007199254740991 or redis.call('PTTL','hold:'..id)<=0 then error('invalid live hold') end
  return value
end
if ownId~='' then
  local rawHold=redis.call('GET',KEYS[8])
  if rawHold then
    own=validateHold(rawHold,ownId)
    if (own.slotKey~=desired.slotKey and own.slotKey~=ARGV[5]) or own.units~=units then return redis.error_reply('payment hold mismatch') end
    local slotIndex=own.slotKey==desired.slotKey and KEYS[5] or KEYS[6]
    if redis.call('SISMEMBER',slotIndex,ownId)~=1 then return redis.error_reply('payment hold missing slot index') end
    if desired.bookingMode=='shared' then
      if own.poolDayKey~=desired.poolKey..'|'..desired.date or redis.call('SISMEMBER',KEYS[7],ownId)~=1 then return redis.error_reply('payment hold missing pool index') end
    elseif own.poolDayKey~=nil then return redis.error_reply('payment hold mode mismatch') end
  end
end
local existing=redis.call('GET',KEYS[1])
if existing then
  local ok,prior=pcall(cjson.decode,existing)
  if not ok or type(prior)~='table' then return redis.error_reply('invalid existing confirmation') end
  for _,field in ipairs({'shop','orderId','slotKey','productId','date','bookingMode','poolKey','guideUnitsRequired'}) do
    if prior[field]~=desired[field] then return redis.error_reply('conflicting confirmation') end
  end
  if (prior.groupKey or prior.lineItemId)~=(desired.groupKey or desired.lineItemId) then return redis.error_reply('conflicting confirmation identity') end
  if flag~='1' or count<units then return redis.error_reply('incomplete existing confirmation') end
  return 0
end
if count+units>9007199254740991 then return redis.error_reply('invalid pool sum') end
local function active(index,byPool)
  if redis.call('SCARD',KEYS[index])>2000 then error('hold index requires reconciliation') end
  local total=0
  for _,id in ipairs(redis.call('SMEMBERS',KEYS[index])) do
    local rawHold=redis.call('GET','hold:'..id)
    if rawHold then
      local item=validateHold(rawHold,id)
      if byPool then
        if item.poolDayKey~=desired.poolKey..'|'..desired.date then error('hold pool mismatch') end
      elseif item.slotKey~=desired.slotKey and item.slotKey~=ARGV[5] then error('hold slot mismatch') end
      -- Only this matching, live payment hold can be converted without counting it twice.
      if not own or id~=ownId then total=total+item.units end
      if total>9007199254740991 then error('invalid hold sum') end
    end
  end
  return total
end
if desired.bookingMode=='private' then
  local lock=redis.call('GET',KEYS[4])
  if flag=='1' or (lock and (not own or lock~=ownId)) or active(5,false)>0 or active(6,false)>0 then return 'UNAVAILABLE' end
  if own and lock~=ownId then return redis.error_reply('payment hold missing private lock') end
else
  local capacity=tonumber(ARGV[3])
  if not capacity or capacity<1 or capacity%1~=0 or capacity>9007199254740991 then return redis.error_reply('invalid capacity limit') end
  if count+active(7,true)+units>capacity then return 'UNAVAILABLE' end
end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('SET',KEYS[2],'1')
redis.call('INCRBY',KEYS[3],ARGV[2])
return 1
`;

export async function confirmRedisBookingCapacity(
  client: { eval(script: string, count: number, ...args: string[]): Promise<unknown> },
  params: Confirmation,
  capacity?: ConfirmationCapacity,
) {
  try {
    if (
      ![
        params.shop,
        params.orderId,
        params.lineItemId,
        params.productId,
        params.date,
        params.poolKey,
        params.groupKey || params.lineItemId,
      ].every((v) => typeof v === "string" && v.length > 0) ||
      params.slotKey !== `${params.productId}|${params.date}` ||
      !["shared", "private"].includes(params.bookingMode) ||
      !Number.isSafeInteger(params.guideUnitsRequired) ||
      params.guideUnitsRequired < 1
    ) {
      throw new Error();
    }
    if (
      !capacity ||
      (capacity.capacityUnits !== null &&
        (!Number.isSafeInteger(capacity.capacityUnits) || capacity.capacityUnits < 1)) ||
      (capacity.holdId !== undefined &&
        (typeof capacity.holdId !== "string" || !capacity.holdId || capacity.holdId.length > 200))
    ) {
      throw new Error();
    }
    const keys = [
      `confirmed:${params.shop}|${params.orderId}|${params.groupKey || params.lineItemId}`,
      `confirmed:${params.slotKey}`,
      `pool:${params.poolKey}|${params.date}`,
    ];
    if (new Set(keys).size !== 3) {
      throw new Error();
    }
    const legacySlot = `slot:${params.productId}:${params.date}::`;
    keys.push(
      `lock:slot:${params.slotKey}`,
      `hold:slot:${params.slotKey}`,
      `hold:slot:${legacySlot}`,
      `hold:pool:${params.poolKey}|${params.date}`,
      capacity.holdId ? `hold:${capacity.holdId}` : `lock:slot:${params.slotKey}`,
    );
    const result = await client.eval(
      CONFIRM,
      keys.length,
      ...keys,
      JSON.stringify(params),
      String(params.guideUnitsRequired),
      capacity.capacityUnits === null ? "" : String(capacity.capacityUnits),
      capacity.holdId ?? "",
      legacySlot,
    );
    if (result === "UNAVAILABLE") {
      throw new BookingCapacityConflict();
    }
    if (result !== 0 && result !== 1) {
      throw new Error();
    }
  } catch (error) {
    if (error instanceof BookingCapacityConflict) {
      throw error;
    }
    throw new Error("Booking capacity confirmation requires reconciliation");
  }
}
