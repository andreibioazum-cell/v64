; M1 validation: enter long mode from reset and exercise 64-bit instructions.
; Loaded as a 64 KiB BIOS image at 0xF0000; reset entry at 0xFFFF0.
;
; Results are stored as qwords at 0x90000 (via r15); a magic byte 'K' is
; written to the serial port when done.

org 0xF0000

%define RESULTS 0x90000

[bits 16]
start16:
    cli

    ; --- build page tables: PML4 @0x1000, PDPT @0x2000, PD @0x3000 ---
    mov edi, 0x1000
    mov ecx, 0x1000          ; clear 0x1000..0x4FFF (16 KiB)
zero_tables:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_tables

    mov dword [0x1000], 0x2007   ; PML4[0] -> PDPT, present+rw+user
    mov dword [0x2000], 0x3007   ; PDPT[0] -> PD, present+rw+user

    ; PD: 2 MiB pages, identity map 0..256 MiB (user+rw so ring 3 works)
    xor eax, eax
    mov edi, 0x3000
    mov ecx, 128
fill_pd:
    mov edx, eax
    shl edx, 21
    or  edx, 0x87              ; P|RW|US|PS
    mov [edi], edx
    mov dword [edi+4], 0
    inc eax
    add edi, 8
    dec ecx
    jnz fill_pd

    ; PD[256]: 2 MiB page at 0x20000000 (phys 0x200000), with the NX bit set
    mov dword [0x3000 + 256*8], 0x00200087
    mov dword [0x3000 + 256*8 + 4], 0x80000000  ; bit 63 = NX

    ; execute a stub in RAM at phys 0x7000 (retf) so that its page is known to
    ; the jit (entry points recorded), see test 71
    xor ax, ax
    mov es, ax
    mov byte [es:0x7000], 0xCB   ; retf
    call 0x0000:0x7000

    ; --- GDT at 0x800: null, 64-bit code (0x08), data (0x10) ---
    xor eax, eax
    mov edi, 0x800
    mov ecx, 6
zero_gdt:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_gdt
    mov dword [0x808], 0x0000FFFF    ; code64: limit
    mov dword [0x80C], 0x00AF9A00    ; P|S|E|RW, G=1 L=1 D=0
    mov dword [0x810], 0x0000FFFF    ; data: limit
    mov dword [0x814], 0x00CF9200    ; P|S|RW, G=1 D=1

    a32 lgdt [gdt_ptr]           ; 32-bit addressing: label is above 64 KiB

    mov eax, cr4
    or  eax, 1 << 5              ; CR4.PAE
    or  eax, 1 << 9              ; CR4.OSFXSR (SSE state)
    or  eax, 1 << 10             ; CR4.OSXMMEXCPT
    mov cr4, eax

    mov ecx, 0xC0000080          ; IA32_EFER
    rdmsr
    or  eax, 0x100 | 0x800       ; EFER.LME | EFER.NXE
    wrmsr

    mov eax, 0x1000
    mov cr3, eax

    mov eax, cr0
    or  eax, 0x80000001          ; CR0.PE|CR0.PG
    mov cr0, eax

    ; far jump into 64-bit code segment (32-bit operand in 16-bit segment)
[bits 16]
    o32 jmp 0x08:longmode

[bits 64]
longmode:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov rsp, 0x80000
    mov r15, RESULTS

    ; ======== test 0: mov r64, imm64 (REX.W B8) ========
    mov rax, 0x1122334455667788
    mov [r15 + 0*8], rax

    ; ======== test 1: mov r8, imm64 + add r64 ========
    mov r8, 0x1111111111111111
    add rax, r8                  ; 0x2233445566778899
    mov [r15 + 1*8], rax

    ; ======== test 2: 32-bit op zero-extends ========
    mov rax, -1
    mov eax, 0x89ABCDEF          ; rax = 0x0000000089ABCDEF
    mov [r15 + 2*8], rax

    ; ======== test 3: add flags + jo ========
    mov rax, 0x7FFFFFFFFFFFFFFF
    add rax, 1                   ; OF=1, SF=1
    mov rax, 0
    jo  t3_of
    mov rax, 0xDEAD
t3_of:
    mov [r15 + 3*8], rax         ; expect 0xDEAD

    ; ======== test 4: sub + js ========
    mov rax, 5
    sub rax, 10                  ; negative
    mov rax, 0
    js  t4_neg
    mov rax, 0xFFFF
t4_neg:
    mov [r15 + 4*8], rax         ; expect 0

    ; ======== test 5/6: 8-bit REX registers (sil, r8b) ========
    mov rsi, 0x4142434445464748
    mov r8, 0xFF
    mov sil, 0x00                ; low byte of rsi
    mov r8b, 0x42
    mov [r15 + 5*8], rsi         ; 0x4142434445464700
    mov [r15 + 6*8], r8          ; 0x42

    ; ======== test 7: RIP-relative load/store ========
    mov rax, 0xCAFEBABEDEADBEEF
    mov [rel scratch], rax
    mov rax, 0
    mov rax, [rel scratch]
    mov [r15 + 7*8], rax

    ; ======== test 8: SIB with r8 base, r9 index ========
    mov r8, 0x90000
    mov r9, 2
    mov rax, 0x0123456789ABCDEF
    mov [r8 + r9*8 + 0x100], rax ; -> 0x90110
    mov rax, 0
    mov rax, [r8 + r9*8 + 0x100]
    mov [r15 + 8*8], rax

    ; ======== test 9/10: push/pop + call/ret ========
    mov rax, 0x1234567890ABCDEF
    push rax
    mov rax, 0
    pop  rax
    mov [r15 + 9*8], rax
    call sub1
    mov [r15 + 10*8], rax        ; expect 0x42

    ; ======== test 11-14: shifts ========
    mov rax, 1
    shl rax, 63
    mov [r15 + 11*8], rax        ; 0x8000000000000000
    shr rax, 60
    mov [r15 + 12*8], rax        ; 8
    mov rax, 0x8000000000000000
    sar rax, 63
    mov [r15 + 13*8], rax        ; -1
    mov rax, 0x0123456789ABCDEF
    mov cl, 8
    shl rax, cl
    mov [r15 + 14*8], rax        ; 0x23456789ABCDEF00

    ; ======== test 15-18: imul/mul/div ========
    mov rax, 0x100000000
    mov rbx, 0x100000000
    imul rax, rbx                ; 2^64 wraps to 0, OF=1
    mov [r15 + 15*8], rax        ; 0
    mov rax, 0x100000000
    mul  rbx                     ; rdx:rax = 2^64 -> rdx=1 rax=0
    mov [r15 + 16*8], rdx        ; 1
    mov rdx, 0
    mov rax, 0x123456789ABCDEF0
    mov rbx, 0x100
    div  rbx
    mov [r15 + 17*8], rax        ; 0x123456789ABCDE
    mov [r15 + 18*8], rdx        ; 0xF0

    ; ======== test 19-21: movsxd / movzx / movsx ========
    mov dword [rel scratch], 0x80000001
    movsxd rax, dword [rel scratch]
    mov [r15 + 19*8], rax        ; 0xFFFFFFFF80000001
    movzx rax, byte [rel scratch]
    mov [r15 + 20*8], rax        ; 1
    movsx rax, byte [rel scratch]
    mov [r15 + 21*8], rax        ; 1

    ; ======== test 22-25: xchg + bswap + inc/dec ========
    mov rax, 0x1111
    mov rbx, 0x2222
    xchg rax, rbx
    mov [r15 + 22*8], rax        ; 0x2222
    mov rax, 0x0123456789ABCDEF
    bswap rax
    mov [r15 + 23*8], rax        ; 0xEFCDAB8967452301
    mov rax, 0xFFFFFFFFFFFFFFFF
    inc rax                      ; 0, ZF=1
    mov rbx, 0
    jz t23_z
    mov rbx, 1
t23_z:
    mov [r15 + 24*8], rbx        ; 0
    mov eax, 0xFFFFFFFF
    inc eax                      ; 32-bit inc in long mode
    mov [r15 + 25*8], rax        ; 0

    ; ======== test 26: lea64 RIP-relative ========
    lea rax, [rel scratch]
    mov rbx, [rel scratch_ptr]   ; absolute address of scratch
    sub rax, rbx
    mov [r15 + 26*8], rax        ; expect 0

    ; ======== test 27: loop (RCX) ========
    mov rcx, 5
    xor rax, rax
t27_loop:
    add rax, 3
    loop t27_loop
    mov [r15 + 27*8], rax        ; 15

    ; ======== test 28: fs base via MSR ========
    mov r10, 0x70000
    mov rax, 0xAABBCCDD
    mov [r10], rax
    mov ecx, 0xC0000100          ; IA32_FS_BASE
    mov eax, 0x70000
    xor edx, edx
    wrmsr
    xor r10d, r10d
    mov rax, fs:[r10]
    mov [r15 + 28*8], rax        ; 0xAABBCCDD

    ; ======== test 29-32: and/or/xor/not/neg ========
    mov rax, 0xFF00FF00FF00FF00
    mov rbx, 0x0FF00FF00FF00FF0
    and rax, rbx
    mov [r15 + 29*8], rax        ; 0x0F000F000F000F00
    mov rbx, 0xF00000000000000F
    or  rax, rbx
    mov [r15 + 30*8], rax        ; 0xFF000F000F000F0F
    xor rax, rax
    not rax
    mov [r15 + 31*8], rax        ; -1
    neg rax
    mov [r15 + 32*8], rax        ; 1

    ; ======== test 33/34: cmp + setcc + cmov ========
    mov rax, 100
    mov rbx, 200
    cmp rax, rbx
    setl al                      ; 1
    movzx rax, al
    mov [r15 + 33*8], rax        ; 1
    mov rax, 10
    cmovl rax, rbx               ; rax = 200
    mov [r15 + 34*8], rax        ; 200

    ; ======== test 35-38: cdqe/cqo, adc/sbb ========
    mov eax, 0x80000000
    cdqe
    mov [r15 + 35*8], rax        ; 0xFFFFFFFF80000000
    cqo                          ; rdx = -1
    mov [r15 + 36*8], rdx
    mov rax, 0xFFFFFFFFFFFFFFFF
    add rax, 1                   ; CF=1
    mov rax, 5
    adc rax, 0                   ; 6
    mov [r15 + 37*8], rax
    mov rax, 0
    stc
    sbb rax, -1                  ; 0 - (-1) - 1 = 0
    mov [r15 + 38*8], rax

    ; ======== test 47-49: cmpxchg16b ========
    mov rax, 0x1111111111111111
    mov rdx, 0x2222222222222222
    mov rbx, 0x3333333333333333
    mov rcx, 0x4444444444444444
    mov r10, 0xAAAA2222BBBB1111
    mov [rel cx16_scratch], r10
    cmpxchg16b [rel cx16_scratch]    ; mismatch: rdx:rax <- mem, ZF=0
    mov [r15 + 47*8], rax            ; 0xAAAA2222BBBB1111
    mov [r15 + 48*8], rdx            ; 0
    ; now rdx:rax match memory: exchange rcx:rbx into memory
    mov rbx, 0x5555555555555555
    mov rcx, 0x6666666666666666
    cmpxchg16b [rel cx16_scratch]
    setz al
    movzx rax, al
    mov [r15 + 49*8], rax            ; 1 (ZF set on exchange)
    mov rax, [rel cx16_scratch]
    mov [r15 + 50*8], rax            ; 0x5555555555555555

    ; ======== test 44/45: demand paging through a #PF handler ========
    ; build the IDT (one entry: vector 14 = #PF, 64-bit interrupt gate)
    mov rdi, 0x6000
    mov ecx, 0x100
    xor eax, eax
.idt_zero:
    mov [rdi], rax
    add rdi, 8
    dec ecx
    jnz .idt_zero
    mov rax, pf_handler
    mov rdi, 0x6000 + 14*16
    mov word [rdi], ax                  ; offset 15:0
    mov word [rdi + 2], 0x08            ; selector
    mov byte [rdi + 4], 0x00            ; reserved
    mov byte [rdi + 5], 0x8E            ; P|dpl0|interrupt gate
    shr rax, 16
    mov word [rdi + 6], ax              ; offset 31:16
    shr rax, 16
    mov qword [rdi + 8], rax            ; offset 63:32
    lidt [rel idt_ptr]

    ; the page at phys 0x800000 contains a marker (identity-mapped via 2MiB page)
    mov rax, 0x123456789ABCDEF
    mov [abs 0x800000], rax

    ; fault on the unmapped 0x40000000; the handler maps it and iretq re-runs
    mov rax, [abs 0x40000000]
    mov [r15 + 44*8], rax            ; 0x123456789ABCDEF

    ; ======== test 46: NX fault ========
    ; the 2MiB page at 0x20000000 (phys 0x200000) is mapped NX in the PD; the
    ; #PF handler resumes directly after the "call" (nothing on an NX page can
    ; ever execute)
    mov rax, 0xDEAD
    push after_nx
    jmp 0x20000000                     ; faults on instruction fetch
after_nx:
    add rsp, 8                         ; discard the fake return address
    mov [r15 + 51*8], rax              ; 0xDEAD

    ; ======== test 52: movq xmm8 <-> r64 (REX.W+R, REX.W+B) ========
    mov rax, 0xDEC0DE1122334455
    movq xmm8, rax
    xor rbx, rbx
    movq rbx, xmm8
    mov [r15 + 52*8], rbx            ; 0xDEC0DE1122334455

    ; ======== test 53: movdqa xmm10, xmm9 + por xmm10, xmm11 (high regs) ========
    movq xmm9, rax
    mov rcx, 0x0000FFFF0000FFFF
    movq xmm11, rcx
    movdqa xmm10, xmm9
    por xmm10, xmm11                 ; xmm10 = 0xDEC0FFFF2233FFFF
    movq rbx, xmm10
    mov [r15 + 53*8], rbx

    ; ======== test 54/55: movdqu to/from memory, psrldq ========
    movq xmm12, rax
    movdqu [rel fx_area], xmm12      ; low qword = 0xDEC0DE1122334455
    mov [rel fx_area + 8], rcx       ; high qword = 0x0000FFFF0000FFFF
    movdqu xmm14, [rel fx_area]
    movq rbx, xmm14
    mov [r15 + 54*8], rbx            ; 0xDEC0DE1122334455
    psrldq xmm14, 8
    movq rbx, xmm14
    mov [r15 + 55*8], rbx            ; 0x0000FFFF0000FFFF

    ; ======== test 56/57: cvtsi2sd/cvtsi2ss with r64 + cvt back ========
    mov rbx, 0x123456789ABC
    cvtsi2sd xmm15, rbx              ; F2 REX.W 0F 2A
    cvttsd2si rdx, xmm15             ; F2 REX.W 0F 2C
    mov [r15 + 56*8], rdx            ; 0x123456789ABC
    mov rbx, -123456
    cvtsi2ss xmm15, rbx              ; F3 REX.W 0F 2A
    cvttss2si rdx, xmm15             ; F3 REX.W 0F 2C
    mov [r15 + 57*8], rdx            ; -123456

    ; ======== test 58: fxsave/fxrstor round trip saves xmm8-15 ========
    mov rax, 0xAAAA5555CCCC3333
    movq xmm14, rax
    fxsave [rel fx_area]
    pxor xmm14, xmm14                ; clobber
    fxrstor [rel fx_area]
    movq rbx, xmm14
    mov [r15 + 58*8], rbx            ; 0xAAAA5555CCCC3333

    ; ======== test 39-43: syscall/sysret round trip + swapgs ========
    ; set up IA32_STAR: kernel cs 0x08, user cs 0x18
    xor eax, eax
    mov edx, 0x00180008          ; star[47:32] = 0x08, star[63:48] = 0x18
    mov ecx, 0xC0000081          ; IA32_STAR
    wrmsr
    ; LSTAR = syscall_handler
    mov ecx, 0xC0000082          ; IA32_LSTAR
    mov eax, syscall_handler
    xor edx, edx
    wrmsr
    ; SFMASK: clear DF on syscall
    mov ecx, 0xC0000084          ; IA32_SFMASK
    mov eax, 0x400
    xor edx, edx
    wrmsr
    ; kernel gs base for swapgs
    mov ecx, 0xC0000102          ; IA32_KERNEL_GS_BASE
    mov eax, 0x1234000
    xor edx, edx
    wrmsr
    ; a marker qword at the kernel gs base
    mov rax, 0xFEEDFACEF00DF00D
    mov [abs 0x1234000], rax
    ; enable EFER.SCE
    mov ecx, 0xC0000080          ; IA32_EFER
    rdmsr
    or  eax, 1                   ; SCE
    wrmsr

    ; ======== test 59/60: SIB with REX.X index r12 (lea), r12 base ========
    ; `lea eax, [rcx + r12*2]` encodes SIB.index=4 with REX.X — r12 IS a valid
    ; index register (field 100 means "no index" only without REX.X)
    mov r12, 8
    xor ecx, ecx
    lea eax, [rcx + r12*2]           ; 0 + 8*2
    mov [r15 + 59*8], rax            ; 0x10
    ; r12 as SIB base via REX.B (base field 4 = rsp/r12)
    mov qword [abs 0x92000], 0xFACE
    mov r12, 0x92000 - 4
    mov rax, [r12 + 4]               ; reads [0x92000], SIB base=r12
    mov [r15 + 60*8], rax            ; 0xFACE

    ; ======== test 61/62: FS/GS/KERNEL_GS MSR addressing sanity ========
    mov ecx, 0xC0000101              ; IA32_GS_BASE
    mov rax, 0xA5A5DEAD
    xor edx, edx
    wrmsr
    rdmsr
    mov [r15 + 61*8], rax            ; 0xA5A5DEAD (read back of gs base)
    ; kernel gs base still holds its marker (separate MSR!):
    mov ecx, 0xC0000102              ; IA32_KERNEL_GS_BASE
    rdmsr
    mov [r15 + 62*8], rax            ; 0x1234000
    ; restore the user gs base (the swapgs test expects it swapped in/out)
    mov ecx, 0xC0000101              ; IA32_GS_BASE
    mov eax, 0x1234000               ; (same marker as the kernel gs base here)
    xor edx, edx
    wrmsr

    ; ======== test 63-66: rep stosq (qword memset on the rep fast path) ========
    ; poison the target buffer first
    lea rdi, [rel stos_buf]
    mov rcx, 16
    mov rax, 0xCCCCCCCCCCCCCCCC
    rep stosq
    mov rax, [rel stos_buf + 8]      ; poisoned value
    mov [r15 + 63*8], rax            ; 0xCCCCCCCCCCCCCCCC
    ; the real check: memset 8 qwords via rep stosq
    lea rdi, [rel stos_buf]
    mov rax, 0x1122334455667788
    mov rcx, 8
    rep stosq
    mov rax, [rel stos_buf + 56]     ; last qword written
    mov [r15 + 64*8], rax            ; 0x1122334455667788
    mov rax, [rel stos_buf + 64]     ; first qword past the range (untouched)
    mov [r15 + 65*8], rax            ; 0xCCCCCCCCCCCCCCCC
    lea rax, [rel stos_buf + 64]     ; rdi must have advanced by 8 qwords
    cmp rdi, rax
    sete al
    movzx rax, al
    mov [r15 + 66*8], rax            ; 1

    ; ======== test 67/68/69: TLB invalidation of a 64-bit mapping after PTE rewrite ========
    ; Build a 4 KiB PT at phys 0x6000 and map linear 0x3FE00000 -> phys 0x800000
    mov dword [abs 0x3000 + 511*8], 0x6007    ; PD[511] -> PT@0x6000 (P|RW|US)
    mov dword [abs 0x3000 + 511*8 + 4], 0
    mov dword [abs 0x6000], 0x00800007        ; PT[0] -> phys 0x800000, 4K
    mov dword [abs 0x6004], 0
    mov rax, [abs 0x3FE00000]                 ; warm TLB, content = marker at phys 0x800000
    mov [r15 + 67*8], rax                     ; 0x123456789ABCDEF
    mov rax, 0x0BADC0DEABAD1234
    mov [abs 0x900000], rax                   ; plant a new marker at phys 0x900000
    mov dword [abs 0x6000], 0x00900007        ; PT[0] now -> phys 0x900000
    mov dword [abs 0x6004], 0
    mov rax, cr3
    mov cr3, rax                              ; flush TLB
    mov rbx, [abs 0x3FE00000]
    mov [r15 + 68*8], rbx                     ; 0x0BADC0DEABAD1234 if flushed
    mov dword [abs 0x6000], 0x00800007
    invlpg [abs 0x3FE00000]                   ; selective invalidate
    mov rbx, [abs 0x3FE00000]
    mov [r15 + 69*8], rbx                     ; 0x123456789ABCDEF again

    ; cpuid 0x80000008: eax[7:0] = physical bits, eax[15:8] = linear bits
    mov eax, 0x80000008
    cpuid
    and eax, 0xFFFF
    mov [r15 + 70*8], rax                     ; 0x3020 (48 linear, 32 physical)

    ; ======== test 71: write to a page with jit entry points through an alias above 4 GiB ========
    ; PML4[1] aliases the low 1 GiB at 0x8000000000. Dirtying the jit page walks
    ; all tlb entries mapping it, including the high one, whose page number does
    ; not fit the tables for the low 4 GiB (and must not be truncated into them).
    mov dword [abs 0x1000 + 1*8], 0x2007
    mov rax, 0x8000007000
    mov rbx, [rax]                            ; warm the high tlb entry
    mov dword [rax + 0x100], 0x71717171
    mov ebx, [abs 0x7100]
    mov [r15 + 71*8], rbx                     ; 0x71717171

    ; ======== test 72-75: mov r, imm forms, in a loop so that they get jitted ========
    mov ecx, 200000
t72_loop:
    mov rax, -1
    mov eax, 0x12345678                       ; zero-extends
    mov rbx, 0x0008000000000123               ; movabs with bit 51
    mov rdx, -1
    mov dx, 0xBEEF
    mov rsi, -1
    mov ah, 0x5A                              ; legacy high byte register
    mov sil, 0x33                             ; REX byte register
    mov r9, -1
    mov r9b, 0x44
    mov r10, 0x100
    bsf r11, r10                              ; 0F BC: must not be taken for mov r, imm
    mov eax, 7
    mov edi, 7
    mov r12d, 9
    cmpxchg r12d, edi                         ; 0F B1 (eax != r12d: eax <- r12d)
    mov r13, rax
    mov eax, 0x12345678
    mov ah, 0x5A
    dec ecx
    jnz t72_loop
    mov [r15 + 77*8], r11                     ; 8
    mov [r15 + 78*8], r13                     ; 9

    mov [r15 + 72*8], rax                     ; 0x5A78 in the low word: 0x12345A78
    mov [r15 + 73*8], rbx
    mov [r15 + 74*8], rdx                     ; 0xFFFFFFFFFFFFBEEF
    mov [r15 + 75*8], rsi                     ; 0xFFFFFFFFFFFFFF33
    mov [r15 + 76*8], r9                      ; 0xFFFFFFFFFFFFFF44

    ; ======== test 79: conditional jumps after cmp/test/add/and, jitted (hot loop) ========
    xor r13, r13
    mov ecx, 200000
t79_loop:
    mov rax, rcx
    sub rax, 100000
    cmp rax, 7
    jl t79_1
    add r13, 1
t79_1:
    cmp eax, -3
    jbe t79_2
    add r13, 0x100
t79_2:
    test rax, rax
    js t79_3
    add r13, 0x10000
t79_3:
    mov rdx, 0x8000000000000000
    cmp rdx, rax
    jo t79_4
    add r13, 0x1000000
t79_4:
    add rax, -5
    jb t79_5
    mov rdx, 1 << 32
    add r13, rdx
t79_5:
    mov r8d, eax
    and r8d, 0xff
    jle t79_6
    mov rdx, 1 << 40
    add r13, rdx
t79_6:
    dec ecx
    jnz t79_loop
    mov [r15 + 79*8], r13

    ; ======== test 80: imul/shl/shr/sar/setcc/cmovcc, jitted (hot loop) ========
    xor r13, r13
    mov ecx, 100000
    mov rdx, 0x9E3779B97F4A7C15
t80_loop:
    mov rax, rcx
    imul rax, rdx
    mov rbx, rax
    shr rbx, 7
    xor r13, rbx
    mov rbx, rax
    shl rbx, 13
    add r13, rbx
    mov rbx, rax
    sar rbx, 9
    xor r13, rbx
    imul ebx, ecx, -7
    add r13, rbx
    mov r8, rax
    shl r8, 1
    jnc t80_1
    add r13, 3
t80_1:
    mov r9, 5
    mov r10, 9
    mov r11, 0
    cmp ecx, 50000
    cmovl r9, r10
    setge r11b
    add r13, r9
    shl r11, 4
    add r13, r11
    mov r12, -1
    cmp ecx, 0
    cmovl r12d, ecx
    add r13, r12
    dec ecx
    jnz t80_loop
    mov [r15 + 80*8], r13

    ; ======== test 81: rotates, shifts by cl, inc/dec cf, not/neg, movsxd, cdqe/cqo, bswap,
    ; xchg, indirect call/jmp, nops, jitted (hot loop) ========
    xor r13, r13
    mov ecx, 100000
    mov r14, 0x9E3779B97F4A7C15
t81_loop:
    mov rax, rcx
    imul rax, r14
    mov rsi, rax
    mov rbx, rax
    rol rbx, 13
    xor r13, rbx
    mov ebx, eax
    ror ebx, 7
    add r13, rbx
    mov rbx, rax
    shl rbx, cl
    xor r13, rbx
    mov ebx, eax
    shr ebx, cl
    add r13, rbx
    xor r8d, r8d
    cmp rcx, 50000
    inc r8
    adc r13, r8
    mov rbx, rax
    not rbx
    xor r13, rbx
    mov rbx, rax
    neg rbx
    add r13, rbx
    movsxd r9, eax
    add r13, r9
    db 0x44, 0x63, 0xD0                       ; 63 without REX.W: mov r10d, eax
    add r13, r10
    cdqe
    xor r13, rax
    mov rax, rsi
    cqo
    add r13, rdx
    mov rbx, rsi
    bswap rbx
    xor r13, rbx
    mov ebx, esi
    bswap ebx
    add r13, rbx
    mov r11, rsi
    mov r12, rcx
    xchg r11, r12
    add r13, r11
    nop
    db 0x0F, 0x1F, 0x44, 0x00, 0x00           ; nop dword [rax + rax]
    db 0xF3, 0x0F, 0x1E, 0xFA                 ; endbr64
    lea rbx, [rel t81_after_jmp]
    jmp rbx
    hlt
t81_after_jmp:
    mov rax, rsi
    lea rbx, [rel t81_func]
    call rbx
    add r13, rax
    dec ecx
    jnz t81_loop
    mov [r15 + 81*8], r13

    ; ======== test 82: inc at a block start keeps cf for a following adc (hot loop) ========
    xor r13, r13
    mov ecx, 100000
t82_loop:
    mov eax, ecx
    and eax, 1
    jz t82_clear
    stc
    jmp t82_inc
t82_clear:
    clc
    jmp t82_inc
t82_inc:
    inc r8
    adc r13, 0                                ; +1 for odd counts
    inc r9
    cmp r9, 0                                 ; inc's cf is dead here
    dec ecx
    jnz t82_loop
    mov [r15 + 82*8], r13

    ; ======== test 83: adc/sbb, bt*, cmpxchg, xadd, pushf, jitted (hot loop) ========
    xor r13, r13
    mov ecx, 100000
    mov r14, 0x9E3779B97F4A7C15
t83_loop:
    mov rsi, rcx
    imul rsi, r14
    mov rax, rsi
    add rax, rax
    adc r13, rcx
    mov ebx, esi
    sub ebx, ecx
    mov r11, rsi
    sbb r11, 12345
    xor r13, r11
    mov rbx, rsi
    bt rbx, rcx
    adc r13, 0
    bts rbx, 5
    btr rbx, 60
    btc rbx, rcx
    add r13, rbx
    mov [r15 + 120*8], rsi
    bts qword [r15 + 120*8], 7
    btr qword [r15 + 120*8], 63
    add r13, [r15 + 120*8]
    mov [r15 + 120*8], rsi
    mov rax, rcx
    mov rbx, 77
    lock cmpxchg [r15 + 120*8], rbx
    add r13, rax
    add r13, [r15 + 120*8]
    mov rax, rsi
    cmpxchg [r15 + 120*8], rbx
    add r13, [r15 + 120*8]
    mov [r15 + 120*8], rcx
    mov rbx, rsi
    xadd [r15 + 120*8], rbx
    add r13, rbx
    add r13, [r15 + 120*8]
    mov rbx, 3
    mov rdx, rcx
    xadd rdx, rbx
    add r13, rdx
    add r13, rbx
    cmp rcx, 50000
    pushfq
    pop rbx
    and ebx, 0x8D5
    add r13, rbx
    dec ecx
    jnz t83_loop
    mov [r15 + 83*8], r13
    jmp t81_done
t81_func:
    add rax, 1
    ret
t81_done:

    ; mask all PIC interrupts: user mode runs with IF set below (test 84)
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al

    ; set DF before the syscall: r11 must carry it, rflags must lose it
    pushfq
    or  qword [rsp], 0x400
    popfq
    syscall
after_syscall1:
    ; we are now at cpl 3 (sysret); rflags were loaded from r11, including IF
    pushfq
    pop rax
    and rax, 0x200
    mov [r15 + 84*8], rax        ; 0x200
    ; immediately syscall back
    syscall
after_syscall2:
    ; we are at cpl 3 again; the third syscall makes the handler write 'K'
    ; from ring 0 and halt
    syscall
after_syscall3:
    ; not reached
    jmp hang

; ---- fallback: reached only when syscalls are not enabled ----
    mov al, 'K'
    mov dx, 0x3F8
    out dx, al
hang:
    hlt
    jmp hang

; ---- syscall handler (ring 0, entered with rcx=return rip, r11=rflags) ----
syscall_handler:
    mov r14, rcx                 ; save the return rip (rcx is clobbered below)
    swapgs                       ; kernel view of the gs base while in the handler
    mov rax, [rel call_count]
    inc rax
    mov [rel call_count], rax
    cmp rax, 1
    je .first
    cmp rax, 2
    je .second

    ; third call: done - write 'K' and halt
    mov al, 'K'
    mov dx, 0x3F8
    out dx, al
.hang:
    hlt
    jmp .hang

.first:
    ; rcx = rip of the instruction after syscall
    mov rax, after_syscall1
    cmp rcx, rax
    sete al
    movzx rax, al
    mov [r15 + 39*8], rax        ; 1
    ; r11 = original rflags (with DF still set)
    mov rax, r11
    and rax, 0x400
    mov [r15 + 40*8], rax        ; 0x400
    ; rflags in the handler have DF masked away by SFMASK
    pushfq
    pop rax
    and rax, 0x400
    mov [r15 + 41*8], rax        ; 0
    ; return to user mode with interrupts enabled
    or r11, 0x200
    swapgs
    mov rcx, r14
    sysret

.second:
    ; entered from cpl 3; gs base is the kernel base (swapped on entry)
    mov rax, gs:[0]
    mov [r15 + 42*8], rax        ; 0xFEEDFACEF00DF00D
    ; gs base is now the kernel base: rdmsr IA32_GS_BASE confirms
    mov ecx, 0xC0000101           ; IA32_GS_BASE
    rdmsr
    shl rdx, 32
    or  rax, rdx
    mov [r15 + 43*8], rax        ; 0x1234000
    swapgs
    mov rcx, r14
    sysret

; ---- #PF handler: demand-paging for 0x40000000, skip for the NX page ----
pf_handler:
    mov r8, cr2
    mov rdx, 0x40000000
    cmp r8, rdx
    je .demand
    ; NX page: store the I/D bit of the error code and resume at a fixed label
    mov r8, [rsp]                ; error code
    shr r8, 4
    and r8, 1
    mov [r15 + 46*8], r8         ; 1
    add rsp, 8                   ; pop error code
    mov r8, after_nx
    mov [rsp], r8                ; rip <- after_nx
    iretq

.demand:
    ; map PDPT[1] -> PD2 @0x5000, PD2[0] -> 2MiB page @phys 0x800000
    mov dword [abs 0x2008], 0x5007   ; P|RW|US
    mov dword [abs 0x5000], 0x800087 ; P|RW|US|PS
    mov dword [abs 0x5004], 0
    ; error code: not-present (bit 0 clear)
    mov rax, [rsp]
    and rax, 1
    xor rax, 1
    mov [r15 + 45*8], rax        ; 1
    add rsp, 8
    iretq                        ; re-executes the faulting instruction

sub1:
    push rbp
    mov rbp, rsp
    mov rax, 0x42
    pop rbp
    ret

scratch: dq 0
scratch_ptr: dq scratch
call_count: dq 0
cx16_scratch: dq 0, 0

align 16
fx_area: times 64 dq 0             ; 512-byte fxsave area (16-byte aligned)
stos_buf: times 32 dq 0            ; rep stosq playground

idt_ptr:
    dw 0xFF                      ; 16 entries - 1
    dq 0x6000

gdt_ptr:
    dw 0x17                      ; 3 entries - 1
    dd 0x800

[bits 16]
    ; reset vector at file offset 0xFFF0
    times 0xFFF0 - ($ - $$) db 0x90
reset_vector:
    jmp 0xF000:start16 - 0xF0000   ; far jump to the start (cs=0xF000, ip=0)
    times 16 - 5 db 0x90
