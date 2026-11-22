; CPU micro-benchmark for 32-bit protected mode vs 64-bit long mode.
;
; Loaded as a 64 KiB BIOS image. Copies itself to RAM, then runs the same
; workload either in 32-bit protected mode (paging on, identity mapped) or in
; long mode with code and data at higher-half addresses (like Linux). The mode
; is selected at assembly time (-DMODE64 for long mode). When done the checksum
; is stored at 0x508 and 'K' written to the serial port.

%define ITERATIONS 2000
%define ARRAY_DWORDS 4096

%define CODE_PHYS 0x100000          ; benchmark code is copied here
%define DATA_PHYS 0x400000          ; arrays
%define HIGH_CODE 0xFFFFFFFF80000000 ; + phys (kernel text mapping)
%define HIGH_DATA 0xFFFF888000000000 ; + phys (direct map)

%define PML4 0x10000
%define PDPT_LOW 0x11000
%define PDPT_KERNEL 0x12000
%define PDPT_DIRECT 0x13000
%define PD 0x14000
%define PD32 0x15000                ; 32-bit page directory (4 MiB pages)

org 0xF0000

[bits 16]
start16:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000

    a32 lgdt [gdt_ptr]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    o32 jmp 0x18:pm32

[bits 32]
pm32:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, 0x80000

    ; copy the workload to RAM
    mov esi, workload_start
    mov edi, CODE_PHYS
    mov ecx, workload_end - workload_start
    rep movsb

%ifdef MODE64
    jmp setup64
%endif

    ; ---- 32-bit: identity map 0..64 MiB with 4 MiB pages ----
    mov edi, PD32
    mov eax, 0x83 | 0x80            ; P|RW|PS
    mov ecx, 16
.fill:
    mov [edi], eax
    add eax, 0x400000
    add edi, 4
    dec ecx
    jnz .fill
    mov eax, cr4
    or eax, 1 << 4                  ; PSE
    mov cr4, eax
    mov eax, PD32
    mov cr3, eax
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax

    mov esi, DATA_PHYS
    call CODE_PHYS + (bench32 - workload_start)
    mov [0x508], eax
    mov dword [0x50C], 0
    jmp done32

setup64:
    ; ---- 64-bit: identity map 1 GiB, alias at HIGH_CODE and HIGH_DATA ----
    mov edi, PML4
    mov ecx, 0x5000 / 4
    xor eax, eax
    rep stosd
    mov dword [PML4], PDPT_LOW | 3
    mov dword [PML4 + 511*8], PDPT_KERNEL | 3
    mov dword [PML4 + 273*8], PDPT_DIRECT | 3   ; 0xFFFF888000000000
    mov dword [PDPT_LOW], PD | 3
    mov dword [PDPT_KERNEL + 510*8], PD | 3
    mov dword [PDPT_DIRECT], PD | 3
    mov edi, PD
    mov eax, 0x83
    mov ecx, 512
.fill_pd:
    mov [edi], eax
    add eax, 0x200000
    add edi, 8
    dec ecx
    jnz .fill_pd

    mov eax, cr4
    or eax, 1 << 5
    mov cr4, eax
    mov eax, PML4
    mov cr3, eax
    mov ecx, 0xC0000080
    rdmsr
    or eax, 1 << 8
    wrmsr
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax
    jmp 0x08:lm64

done32:
    mov dx, 0x3F8
    mov al, 'K'
    out dx, al
.halt:
    hlt
    jmp .halt

[bits 64]
lm64:
    mov rsp, HIGH_DATA + 0x80000
    mov rsi, HIGH_DATA + DATA_PHYS
    mov rax, HIGH_CODE + CODE_PHYS + (bench64 - workload_start)
    call rax
    mov [abs 0x508], rax
    mov dx, 0x3F8
    mov al, 'K'
    out dx, al
.halt:
    hlt
    jmp .halt

align 8
gdt:
    dq 0
    dq 0x00AF9A000000FFFF           ; 0x08: 64-bit code
    dq 0x00CF92000000FFFF           ; 0x10: data
    dq 0x00CF9A000000FFFF           ; 0x18: 32-bit code
gdt_ptr:
    dw gdt_ptr - gdt - 1
    dd gdt

; ---------------------------------------------------------------------------
; The workload, position independent, assembled once per mode. Takes the
; array base in xSI, returns a checksum in xAX.

%macro WORKLOAD 0
    push xBX
    push xBP
    push xDI
    mov xBP, xSI                    ; array base
    xor xDI, xDI                    ; checksum
    mov ecx, ITERATIONS
%%iteration:
    push xCX

    ; 1. fill: lcg
    mov eax, ecx
    xor ebx, ebx
%%fill:
    imul eax, eax, 1103515245
    add eax, 12345
    mov [xBP + xBX*4], eax
    inc ebx
    cmp ebx, ARRAY_DWORDS
    jb %%fill

    ; 2. sum with a data dependent branch
    xor ebx, ebx
    xor edx, edx
%%sum:
    mov eax, [xBP + xBX*4]
    test eax, 0x10000
    jz %%skip
    add edx, eax
    jmp %%next
%%skip:
    sub edx, eax
%%next:
    inc ebx
    cmp ebx, ARRAY_DWORDS
    jne %%sum
    add edi, edx

    ; 3. calls
    mov ebx, 1000
%%calls:
    mov eax, ebx
    call %%func
    add edi, eax
    dec ebx
    jnz %%calls

    ; 4. memcpy first half to second half (rep movsd) and byte scan
    lea xSI, [xBP]
    lea xDX, [xBP + ARRAY_DWORDS*2]
    push xDI
    mov xDI, xDX
    mov ecx, ARRAY_DWORDS / 2
    rep movsd
    pop xDI
    xor ebx, ebx
%%scan:
    movzx eax, byte [xBP + xBX]
    add edi, eax
    inc ebx
    cmp ebx, 2048
    jne %%scan

    pop xCX
    dec ecx
    jnz %%iteration

    mov eax, edi
    pop xDI
    pop xBP
    pop xBX
    ret

%%func:
    push xBX
    mov ebx, eax
    shl eax, 3
    xor eax, ebx
    lea eax, [eax + ebx*2 + 7]
    pop xBX
    ret
%endmacro

workload_start:

[bits 32]
%define xAX eax
%define xBX ebx
%define xCX ecx
%define xDX edx
%define xSI esi
%define xDI edi
%define xBP ebp
bench32:
    WORKLOAD

[bits 64]
default rel
%define xAX rax
%define xBX rbx
%define xCX rcx
%define xDX rdx
%define xSI rsi
%define xDI rdi
%define xBP rbp
bench64:
    WORKLOAD

workload_end:

    times 0x10000 - 16 - ($ - $$) db 0
[bits 16]
reset:
    jmp 0xF000:start16
    times 0x10000 - ($ - $$) db 0
