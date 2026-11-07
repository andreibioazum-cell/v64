#![allow(non_snake_case)]

use crate::cpu_context::CpuContext;
use crate::gen;
use crate::modrm;
use crate::prefix::{
    PREFIX_66, PREFIX_67, PREFIX_F2, PREFIX_F3, PREFIX_MASK_REX, PREFIX_MASK_SEGMENT,
    PREFIX_REX_PRESENT, PREFIX_REX_W,
};
use crate::regs::{CS, DS, ES, FS, GS, SS};

#[derive(PartialEq, Eq)]
pub enum AnalysisType {
    Normal,
    BlockBoundary,
    Jump {
        offset: i32,
        is_32: bool,
        condition: Option<u8>,
    },
    STI,
}

pub struct Analysis {
    pub no_next_instruction: bool,
    pub absolute_jump: bool,
    pub ty: AnalysisType,
}

pub fn analyze_step(mut cpu: &mut CpuContext) -> Analysis {
    let mut analysis = Analysis {
        no_next_instruction: false,
        absolute_jump: false,
        ty: AnalysisType::Normal,
    };
    cpu.prefixes = 0;
    if cpu.is_64() {
        analyze_opcode64(&mut cpu, &mut analysis);
        fixup_analysis64(&cpu, &mut analysis);
        return analysis;
    }
    let opcode = cpu.read_imm8() as u32 | (cpu.osize_32() as u32) << 8;
    gen::analyzer::analyzer(opcode, &mut cpu, &mut analysis);
    analysis
}

/// Read and analyse an opcode (after any legacy prefixes) in 64-bit mode: handles REX
/// prefixes and picks the operand size tier the same way as the interpreter
/// (run_prefix_instruction): REX.W or a default-64-bit opcode selects the 64-bit tier
pub fn analyze_opcode64(cpu: &mut CpuContext, analysis: &mut Analysis) {
    let opcode = cpu.read_imm8() as u32;
    if opcode & 0xF0 == 0x40 {
        // only the last REX prefix takes effect
        cpu.prefixes =
            cpu.prefixes & !PREFIX_MASK_REX | PREFIX_REX_PRESENT | ((opcode as u16 & 0xF) << 8);
        return analyze_opcode64(cpu, analysis);
    }
    let tier = if cpu.prefixes & PREFIX_REX_W != 0
        || cpu.osize_32() && gen::interpreter::is_default_64_operand_size(opcode)
    {
        0x200
    }
    else {
        (cpu.osize_32() as u32) << 8
    };
    gen::analyzer::analyzer(opcode | tier, cpu, analysis)
}

/// Instructions that the 64-bit jit doesn't compile inline are turned into block boundaries:
/// they run through the generic (interpreter) path, which may change the instruction pointer
fn fixup_analysis64(cpu: &CpuContext, analysis: &mut Analysis) {
    let fallback = match analysis.ty {
        // 16-bit operand size jumps (0x66 prefix) wrap ip to 16 bits; loop/jcxz
        AnalysisType::Jump { is_32: false, .. } => true,
        AnalysisType::Jump {
            condition: Some(c), ..
        } if c >= 0xE0 && c <= 0xE3 => true,
        // 0x67 (32-bit addressing): run in the interpreter
        _ => cpu.prefixes & PREFIX_67 != 0,
    };
    if fallback {
        analysis.ty = AnalysisType::BlockBoundary;
    }
}

pub fn analyze_step_handle_prefix(cpu: &mut CpuContext, analysis: &mut Analysis) {
    if cpu.is_64() {
        return analyze_opcode64(cpu, analysis);
    }
    gen::analyzer::analyzer(
        cpu.read_imm8() as u32 | (cpu.osize_32() as u32) << 8,
        cpu,
        analysis,
    )
}
pub fn analyze_step_handle_segment_prefix(
    segment: u32,
    cpu: &mut CpuContext,
    analysis: &mut Analysis,
) {
    dbg_assert!(segment <= 5);
    // a legacy prefix after a REX prefix annuls the REX prefix
    cpu.prefixes = cpu.prefixes & !(PREFIX_MASK_SEGMENT | PREFIX_MASK_REX) | (segment as u16 + 1);
    analyze_step_handle_prefix(cpu, analysis)
}

pub fn instr16_0F_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    gen::analyzer0f::analyzer(cpu.read_imm8() as u32, cpu, analysis)
}
pub fn instr32_0F_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    let opcode = cpu.read_imm8() as u32;
    if cpu.is_64() && gen::interpreter0f::is_default_64_operand_size(opcode) {
        gen::analyzer0f::analyzer(opcode | 0x200, cpu, analysis)
    }
    else {
        gen::analyzer0f::analyzer(opcode | 0x100, cpu, analysis)
    }
}
pub fn instr64_0F_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    gen::analyzer0f::analyzer(cpu.read_imm8() as u32 | 0x200, cpu, analysis)
}
pub fn instr_26_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(ES, cpu, analysis)
}
pub fn instr_2E_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(CS, cpu, analysis)
}
pub fn instr_36_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(SS, cpu, analysis)
}
pub fn instr_3E_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(DS, cpu, analysis)
}
pub fn instr_64_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(FS, cpu, analysis)
}
pub fn instr_65_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    analyze_step_handle_segment_prefix(GS, cpu, analysis)
}
pub fn instr_66_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    cpu.prefixes = cpu.prefixes & !PREFIX_MASK_REX | PREFIX_66;
    analyze_step_handle_prefix(cpu, analysis)
}
pub fn instr_67_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    cpu.prefixes = cpu.prefixes & !PREFIX_MASK_REX | PREFIX_67;
    analyze_step_handle_prefix(cpu, analysis)
}
pub fn instr_F0_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    // lock: Ignored
    cpu.prefixes &= !PREFIX_MASK_REX;
    analyze_step_handle_prefix(cpu, analysis)
}
pub fn instr_F2_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    cpu.prefixes = cpu.prefixes & !PREFIX_MASK_REX | PREFIX_F2;
    analyze_step_handle_prefix(cpu, analysis)
}
pub fn instr_F3_analyze(cpu: &mut CpuContext, analysis: &mut Analysis) {
    cpu.prefixes = cpu.prefixes & !PREFIX_MASK_REX | PREFIX_F3;
    analyze_step_handle_prefix(cpu, analysis)
}

pub fn modrm_analyze(ctx: &mut CpuContext, modrm_byte: u8) { modrm::skip(ctx, modrm_byte); }
