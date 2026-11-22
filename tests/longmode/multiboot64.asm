; Multiboot kernel in ELF64 format, as produced by most 64-bit hobby kernels:
; linked at a higher-half virtual address, loaded at its physical address,
; entered in 32-bit protected mode. It enables long mode itself, jumps to its
; higher-half alias, stores results at 0x90000 and writes 'K' to the serial
; port when done.
;
; The ELF header is written by hand so that no linker is needed.

%define PBASE 0x100000
%define VBASE 0xFFFFFFFF80000000
%define RESULTS 0x90000
%define PML4 0x200000
%define PDPT_LOW 0x201000
%define PDPT_HIGH 0x202000
%define PD 0x203000

[bits 32]
org PBASE

elf_header:
    db 0x7F, "ELF", 2, 1, 1, 0      ; 64-bit, little endian, version 1
    times 8 db 0
    dw 2                            ; executable
    dw 0x3E                         ; x86-64
    dd 1
    dq VBASE + entry32              ; entry (virtual; loader adjusts it to paddr)
    dq program_header - elf_header  ; phoff
    dq 0                            ; shoff
    dd 0                            ; flags
    dw 64                           ; ehsize
    dw 56                           ; phentsize
    dw 1                            ; phnum
    dw 64                           ; shentsize
    dw 0                            ; shnum
    dw 0                            ; shstrndx

program_header:
    dd 1                            ; PT_LOAD
    dd 7                            ; rwx
    dq 0                            ; offset
    dq VBASE + PBASE                ; vaddr
    dq PBASE                        ; paddr
    dq file_end - elf_header        ; filesz
    dq file_end - elf_header + 0x1000 ; memsz (includes a bss page)
    dq 0x1000

align 4
multiboot_header:
    dd 0x1BADB002
    dd 0                            ; flags: no address fields, use the elf headers
    dd -0x1BADB002

entry32:
    mov [RESULTS + 0*8], eax
    mov dword [RESULTS + 0*8 + 4], 0
    mov [RESULTS + 1*8], ebx
    mov dword [RESULTS + 1*8 + 4], 0

    ; page tables: identity map the first 1 GiB and alias it at VBASE
    mov edi, PML4
    mov ecx, 0x4000 / 4
    xor eax, eax
    rep stosd

    mov dword [PML4], PDPT_LOW | 3
    mov dword [PML4 + 511*8], PDPT_HIGH | 3
    mov dword [PDPT_LOW], PD | 3
    mov dword [PDPT_HIGH + 510*8], PD | 3

    mov edi, PD
    mov eax, 0x83                   ; P|RW|PS
    mov ecx, 512
.fill_pd:
    mov [edi], eax
    add eax, 0x200000
    add edi, 8
    dec ecx
    jnz .fill_pd

    lgdt [gdt_ptr]

    mov eax, cr4
    or eax, 1 << 5                  ; PAE
    mov cr4, eax
    mov eax, PML4
    mov cr3, eax
    mov ecx, 0xC0000080
    rdmsr
    or eax, 1 << 8                  ; EFER.LME
    wrmsr
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax

    jmp 0x08:entry64

[bits 64]
default abs
entry64:
    mov rax, VBASE + high_half
    jmp rax

high_half:
    lea rax, [rel high_half]
    mov [RESULTS + 2*8], rax
    ; write through the higher-half alias, read back through the identity map
    mov rbx, 0x1122334455667788
    mov rcx, VBASE + RESULTS + 3*8
    mov [rcx], rbx
    ; the bss page past filesz is zero
    mov rax, [rel file_end]
    mov [RESULTS + 4*8], rax

    mov dx, 0x3F8
    mov al, 'K'
    out dx, al
.halt:
    cli
    hlt
    jmp .halt

align 8
gdt:
    dq 0
    dq 0x00AF9A000000FFFF           ; 0x08: 64-bit code
    dq 0x00CF92000000FFFF           ; 0x10: data
gdt_ptr:
    dw gdt_ptr - gdt - 1
    dd gdt

file_end:
