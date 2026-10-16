#![allow(non_upper_case_globals)]

use crate::cpu::cpu::reg128;
use crate::softfloat::F80;
use crate::state_flags::CachedStateFlags;

// 16 general purpose registers, 64 bits each (little-endian).
// The 8/16/32-bit views alias the low bytes of the 64-bit registers.
pub const reg8: *mut u8 = 128 as *mut u8;
pub const reg16: *mut u16 = 128 as *mut u16;
pub const reg32: *mut i32 = 128 as *mut i32;
pub const reg64: *mut u64 = 128 as *mut u64;

pub const last_op_size: *mut i32 = 96 as *mut i32;
pub const flags_changed: *mut i32 = 100 as *mut i32;
pub const last_op1: *mut i32 = 104 as *mut i32;
pub const state_flags: *mut CachedStateFlags = 108 as *mut CachedStateFlags;
pub const last_result: *mut i32 = 112 as *mut i32;
pub const flags: *mut i32 = 120 as *mut i32;

pub const segment_access_bytes: *mut u8 = 512 as *mut u8; // TODO: reorder below segment_limits

pub const apic_enabled: *mut bool = 548 as *mut bool;
pub const acpi_enabled: *mut bool = 552 as *mut bool;

pub const idtr_size: *mut i32 = 564 as *mut i32;
pub const idtr_offset: *mut i32 = 568 as *mut i32;
pub const gdtr_size: *mut i32 = 572 as *mut i32;
pub const gdtr_offset: *mut i32 = 576 as *mut i32;
pub const cr: *mut i32 = 580 as *mut i32;
pub const cpl: *mut u8 = 612 as *mut u8;
pub const in_hlt: *mut bool = 616 as *mut bool;
pub const last_virt_eip: *mut i32 = 620 as *mut i32;
pub const eip_phys: *mut i32 = 624 as *mut i32;

pub const sysenter_cs: *mut i32 = 636 as *mut i32;
pub const sysenter_esp: *mut i32 = 640 as *mut i32;
pub const sysenter_eip: *mut i32 = 644 as *mut i32;
pub const prefixes: *mut u16 = 648 as *mut u16;
pub const instruction_counter: *mut u32 = 664 as *mut u32;
pub const sreg: *mut u16 = 668 as *mut u16;
pub const dreg: *mut i32 = 684 as *mut i32;

// filled in by svga_fill_pixel_buffer, read by javacsript for optimised putImageData calls
pub const svga_dirty_bitmap_min_offset: *mut u32 = 716 as *mut u32;
pub const svga_dirty_bitmap_max_offset: *mut u32 = 720 as *mut u32;

pub const segment_is_null: *mut bool = 724 as *mut bool;
pub const segment_offsets: *mut i32 = 736 as *mut i32;
pub const segment_limits: *mut u32 = 768 as *mut u32;

pub const protected_mode: *mut bool = 800 as *mut bool;
pub const is_32: *mut bool = 804 as *mut bool;
pub const stack_size_32: *mut bool = 808 as *mut bool;
pub const memory_size: *mut u32 = 812 as *mut u32;
pub const fpu_stack_empty: *mut u8 = 816 as *mut u8;
pub const mxcsr: *mut i32 = 824 as *mut i32;

pub const reg_xmm: *mut reg128 = 832 as *mut reg128;
// xmm8-15 (only addressable in 64-bit mode via REX.R/REX.B on SSE encodings)
pub const reg_xmm_high: *mut reg128 = 1408 as *mut reg128;
pub const current_tsc: *mut u64 = 960 as *mut u64;

pub const reg_pdpte: *mut u64 = 968 as *mut u64; // 4 64-bit entries

pub const fpu_stack_ptr: *mut u8 = 1032 as *mut u8;
pub const fpu_control_word: *mut u16 = 1036 as *mut u16;
pub const fpu_status_word: *mut u16 = 1040 as *mut u16;
pub const fpu_opcode: *mut i32 = 1044 as *mut i32;
pub const fpu_ip: *mut i32 = 1048 as *mut i32;
pub const fpu_ip_selector: *mut i32 = 1052 as *mut i32;
pub const fpu_dp: *mut i32 = 1056 as *mut i32;
pub const fpu_dp_selector: *mut i32 = 1060 as *mut i32;
pub const tss_size_32: *mut bool = 1128 as *mut bool;

pub const sse_scratch_register: *mut reg128 = 1136 as *mut reg128;

pub const fpu_st: *mut F80 = 1152 as *mut F80;
pub const pat: *mut u64 = 1288 as *mut u64;

pub const is_64: *mut bool = 272 as *mut bool;

// lazy flag operands for 64-bit operations (last_op_size == OPSIZE_64)
pub const last_op1_64: *mut u64 = 280 as *mut u64;
pub const last_result_64: *mut u64 = 288 as *mut u64;

// 64-bit MSRs
pub const efer: *mut u64 = 296 as *mut u64;
pub const star: *mut u64 = 304 as *mut u64;
pub const lstar: *mut u64 = 312 as *mut u64;
pub const cstar: *mut u64 = 320 as *mut u64;
pub const sfmask: *mut u64 = 328 as *mut u64;
pub const fs_base: *mut u64 = 336 as *mut u64;
pub const gs_base: *mut u64 = 344 as *mut u64;
pub const kernel_gs_base: *mut u64 = 352 as *mut u64;

// 64-bit instruction pointer / previous ip (moved off the old i32 slots at
// 556/560 so that full 48-bit linear addresses fit; the JS side in cpu.js has
// matching views)
pub const instruction_pointer: *mut u64 = 256 as *mut u64;
pub const previous_ip: *mut u64 = 264 as *mut u64;

// per-page cache of the physical address of the current instruction page
// (see get_phys_eip); 64-bit variants of the i32 slots at 620/624
pub const last_virt_eip64: *mut i64 = 368 as *mut i64;
pub const eip_phys64: *mut u64 = 376 as *mut u64;

// cr2 with the full 64-bit fault address (the i32 cr[2] keeps a low-32 mirror
// for 32-bit paths and JS)
pub const cr2_64: *mut u64 = 384 as *mut u64;

// gdtr/idtr base as full 64-bit linear addresses (the i32 slots at 568/576 keep
// low-32 mirrors for JS)
pub const idtr_offset64: *mut u64 = 392 as *mut u64;
pub const gdtr_offset64: *mut u64 = 400 as *mut u64;

// sysenter esp/eip as full 64-bit values (the i32 slots at 640/644 keep
// low-half mirrors for 32-bit paths)
pub const sysenter_esp64: *mut u64 = 408 as *mut u64;
pub const sysenter_eip64: *mut u64 = 416 as *mut u64;

// ia32_misc_enable (value retained, semantics not modelled)
pub const misc_enable: *mut u64 = 424 as *mut u64;

// NMI bookkeeping: pending (latched) and blocked (in an NMI handler, until iret)
pub const nmi_pending: *mut bool = 432 as *mut bool;
pub const nmi_blocked: *mut bool = 433 as *mut bool;

// the 64-bit base of the TSS. In long mode the TSS descriptor is 16 bytes wide
// and its base is a full 64-bit address (split across both words), while the
// i32 segment_offsets[TR] mirrors only its low half
pub const tss_base64: *mut u64 = 456 as *mut u64;

pub fn get_reg32_offset(r: u32) -> u32 {
    dbg_assert!(r < 16);
    (unsafe { reg32.offset((r * 2) as isize) }) as u32
}

pub fn get_reg64_offset(r: u32) -> u32 {
    dbg_assert!(r < 16);
    (unsafe { reg64.offset(r as isize) }) as u32
}

pub fn get_reg_mmx_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    (unsafe { fpu_st.offset(r as isize) }) as u32
}

pub fn get_reg_xmm_offset(r: u32) -> u32 {
    dbg_assert!(r < 16);
    if r < 8 {
        (unsafe { reg_xmm.offset(r as isize) }) as u32
    }
    else {
        (unsafe { reg_xmm_high.offset(r as isize - 8) }) as u32
    }
}

pub fn get_sreg_offset(s: u32) -> u32 {
    dbg_assert!(s < 6);
    (unsafe { sreg.offset(s as isize) }) as u32
}

pub fn get_seg_offset(s: u32) -> u32 {
    dbg_assert!(s < 8);
    (unsafe { segment_offsets.offset(s as isize) }) as u32
}

pub fn get_segment_is_null_offset(s: u32) -> u32 {
    dbg_assert!(s < 8);
    (unsafe { segment_is_null.offset(s as isize) }) as u32
}

pub fn get_creg_offset(i: u32) -> u32 {
    dbg_assert!(i < 8);
    (unsafe { cr.offset(i as isize) }) as u32
}
