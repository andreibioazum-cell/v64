use crate::cpu::memory;
use crate::prefix::{
    PREFIX_MASK_ADDRSIZE, PREFIX_MASK_OPSIZE, PREFIX_REX_B, PREFIX_REX_R, PREFIX_REX_W,
    PREFIX_REX_X,
};
use crate::state_flags::CachedStateFlags;

#[derive(Clone)]
pub struct CpuContext {
    pub eip: u32,
    pub prefixes: u16,
    pub cs_offset: u32,
    pub state_flags: CachedStateFlags,
}

impl CpuContext {
    pub fn advance16(&mut self) {
        dbg_assert!(self.eip & 0xFFF < 0xFFE);
        self.eip += 2;
    }
    pub fn advance32(&mut self) {
        dbg_assert!(self.eip & 0xFFF < 0xFFC);
        self.eip += 4;
    }
    #[allow(unused)]
    pub fn advance_moffs(&mut self) {
        if self.is_64() {
            let _ = self.read_moffs64();
        }
        else if self.asize_32() {
            self.advance32()
        }
        else {
            self.advance16()
        }
    }

    pub fn read_imm8(&mut self) -> u8 {
        dbg_assert!(self.eip & 0xFFF < 0xFFF);
        let v = memory::read8(self.eip) as u8;
        self.eip += 1;
        v
    }
    pub fn read_imm8s(&mut self) -> i8 { self.read_imm8() as i8 }
    pub fn read_imm16(&mut self) -> u16 {
        dbg_assert!(self.eip & 0xFFF < 0xFFE);
        let v = memory::read16(self.eip) as u16;
        self.eip += 2;
        v
    }
    pub fn read_imm32(&mut self) -> u32 {
        dbg_assert!(self.eip & 0xFFF < 0xFFC);
        let v = memory::read32s(self.eip) as u32;
        self.eip += 4;
        v
    }
    pub fn read_imm64(&mut self) -> u64 {
        dbg_assert!(self.eip & 0xFFF < 0xFF8);
        let v = unsafe { memory::read64s(self.eip) } as u64;
        self.eip += 8;
        v
    }
    /// Not for 64-bit mode, see read_moffs64
    pub fn read_moffs(&mut self) -> u32 {
        dbg_assert!(!self.is_64());
        if self.asize_32() {
            self.read_imm32()
        }
        else {
            self.read_imm16() as u32
        }
    }
    /// In 64-bit mode the moffs is 8 bytes wide (4 with 0x67)
    pub fn read_moffs64(&mut self) -> u64 {
        if self.is_64() {
            if self.prefixes & PREFIX_MASK_ADDRSIZE != 0 {
                self.read_imm32() as u64
            }
            else {
                self.read_imm64()
            }
        }
        else {
            self.read_moffs() as u64
        }
    }

    pub fn cpl3(&self) -> bool { self.state_flags.cpl3() }
    pub fn has_flat_segmentation(&self) -> bool { self.state_flags.has_flat_segmentation() }
    pub fn is_64(&self) -> bool { self.state_flags.is_64() }
    /// In 64-bit mode: true for the default (32-bit) operand size, see also rex_w
    pub fn osize_32(&self) -> bool {
        if self.is_64() {
            self.prefixes & PREFIX_MASK_OPSIZE == 0
        }
        else {
            self.state_flags.is_32() != (self.prefixes & PREFIX_MASK_OPSIZE != 0)
        }
    }
    /// In 64-bit mode the address size is 64 (or 32 with 0x67): both use the 32-bit modrm
    /// encoding, so this is true for the purpose of instruction decoding
    pub fn asize_32(&self) -> bool {
        if self.is_64() {
            true
        }
        else {
            self.state_flags.is_32() != (self.prefixes & PREFIX_MASK_ADDRSIZE != 0)
        }
    }

    pub fn rex_w(&self) -> bool { self.prefixes & PREFIX_REX_W != 0 }
    /// register number extensions (8 or 0), as folded into register numbers by the decoder
    pub fn rex_r(&self) -> u32 { if self.prefixes & PREFIX_REX_R != 0 { 8 } else { 0 } }
    pub fn rex_x(&self) -> u32 { if self.prefixes & PREFIX_REX_X != 0 { 8 } else { 0 } }
    pub fn rex_b(&self) -> u32 { if self.prefixes & PREFIX_REX_B != 0 { 8 } else { 0 } }
    pub fn ssize_32(&self) -> bool { self.state_flags.ssize_32() }
}
