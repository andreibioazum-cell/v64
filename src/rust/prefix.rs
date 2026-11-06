pub const PREFIX_REPZ: u16 = 0b01000;
pub const PREFIX_REPNZ: u16 = 0b10000;
pub const PREFIX_MASK_REP: u16 = PREFIX_REPZ | PREFIX_REPNZ;

pub const PREFIX_MASK_OPSIZE: u16 = 0b100000;
pub const PREFIX_MASK_ADDRSIZE: u16 = 0b1000000;

pub const PREFIX_66: u16 = PREFIX_MASK_OPSIZE;
pub const PREFIX_67: u16 = PREFIX_MASK_ADDRSIZE;
pub const PREFIX_F2: u16 = PREFIX_REPNZ;
pub const PREFIX_F3: u16 = PREFIX_REPZ;

pub const SEG_PREFIX_ZERO: u16 = 7;

pub const PREFIX_MASK_SEGMENT: u16 = 0b111;

// REX prefix (0x40-0x4F, 64-bit mode only): the 4 payload bits stored as-is
// in bits 8-11 (the REX byte's low nibble is [W,R,X,B] in bits 3-0), plus a
// flag recording that a REX prefix was present at all (relevant for 8-bit
// register encoding: with any REX, AH/CH/DH/BH become SPL/BPL/SIL/DIL)
pub const PREFIX_REX_W: u16 = 0x800;
pub const PREFIX_REX_R: u16 = 0x400;
pub const PREFIX_REX_X: u16 = 0x200;
pub const PREFIX_REX_B: u16 = 0x100;
pub const PREFIX_REX_PRESENT: u16 = 0x1000;
pub const PREFIX_MASK_REX: u16 = 0x1F00;
