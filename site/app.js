// Page logic for the single-file build. ASSETS (base64 wasm and BIOS images) and
// V86 (libv86.js) are inlined by tools/build-single-html.mjs.
/* global ASSETS, V86, atob */

(function()
{
    var MiB = 1024 * 1024;

    // Make codes (set 1) for the keys the phone input sends specially.
    var SCAN_BACKSPACE = [0x0E, 0x8E];
    var SCAN_ENTER = [0x1C, 0x9C];
    var SCAN_CTRL_ALT_DEL = [0x1D, 0x38, 0x53, 0xD3, 0xB8, 0x9D];

    var emulator = null;
    var iso_file = null;
    var paused = false;

    var el = function(id) { return document.getElementById(id); };
    var iso_input = el("iso");
    var iso_name = el("iso_name");
    var start_btn = el("start");
    var pause_btn = el("pause");
    var reset_btn = el("reset");
    var cad_btn = el("cad");
    var fullscreen_btn = el("fullscreen");
    var typing = el("typing");
    var status = el("status");

    function decode_base64(b64)
    {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for(var i = 0; i < bin.length; i++)
        {
            bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
    }

    var wasm_bytes = decode_base64(ASSETS.wasm);
    var seabios = decode_base64(ASSETS.seabios);
    var vgabios = decode_base64(ASSETS.vgabios);

    function set_status(text)
    {
        status.textContent = text;
    }

    function set_running_controls(running)
    {
        pause_btn.disabled = !running;
        reset_btn.disabled = !running;
        cad_btn.disabled = !running;
        fullscreen_btn.disabled = !running;
        typing.disabled = !running;
        pause_btn.textContent = paused ? "Продолжить" : "Пауза";
    }

    function is_small_screen()
    {
        return window.matchMedia("(max-width: 720px)").matches;
    }

    function create_emulator()
    {
        // The guest needs RAM for the live system; smaller phones get less.
        var memory_size = (is_small_screen() ? 256 : 512) * MiB;

        emulator = window.emulator = new V86({
            wasm_fn: function(imports)
            {
                return WebAssembly.instantiate(wasm_bytes, imports).then(function(result)
                {
                    return result.instance.exports;
                });
            },
            screen_container: el("screen_container"),
            memory_size: memory_size,
            vga_memory_size: 8 * MiB,
            bios: { buffer: seabios.buffer },
            vga_bios: { buffer: vgabios.buffer },
            cdrom: { buffer: iso_file },
            autostart: true,
            disable_speaker: true,
        });
    }

    iso_input.addEventListener("change", function()
    {
        var file = iso_input.files && iso_input.files[0];
        if(!file)
        {
            return;
        }

        iso_file = file;
        iso_name.textContent = file.name + " (" + Math.round(file.size / MiB) + " МиБ)";
        start_btn.disabled = false;

        if(emulator)
        {
            // Load the new image into the running machine and reboot from it.
            emulator.set_cdrom({ buffer: file });
            emulator.restart();
            paused = false;
            set_status("Перезапуск с нового образа");
            set_running_controls(true);
        }
        else
        {
            set_status("Образ выбран. Нажмите «Запустить».");
        }
    });

    start_btn.addEventListener("click", function()
    {
        if(!iso_file)
        {
            set_status("Сначала выберите ISO-образ.");
            return;
        }

        start_btn.disabled = true;
        try
        {
            if(!emulator)
            {
                create_emulator();
            }
            else
            {
                emulator.run();
            }
            paused = false;
            set_status("Работает");
            set_running_controls(true);
        }
        catch(err)
        {
            start_btn.disabled = false;
            set_status("Ошибка запуска: " + (err && err.message ? err.message : err));
        }
    });

    pause_btn.addEventListener("click", function()
    {
        if(!emulator)
        {
            return;
        }
        if(paused)
        {
            emulator.run();
            paused = false;
            set_status("Работает");
        }
        else
        {
            emulator.stop();
            paused = true;
            set_status("Пауза");
        }
        set_running_controls(true);
    });

    reset_btn.addEventListener("click", function()
    {
        if(!emulator)
        {
            return;
        }
        emulator.restart();
        paused = false;
        set_status("Перезапуск");
        set_running_controls(true);
    });

    cad_btn.addEventListener("click", function()
    {
        if(emulator)
        {
            emulator.keyboard_send_scancodes(SCAN_CTRL_ALT_DEL, 20);
        }
    });

    fullscreen_btn.addEventListener("click", function()
    {
        if(emulator)
        {
            emulator.screen_go_fullscreen();
        }
    });

    // Phone keyboards do not send physical key events the emulator understands
    // (keyCode 229), so text typed in the input field is sent as characters.
    typing.addEventListener("input", function(e)
    {
        if(e.isComposing || !emulator)
        {
            return;
        }
        var text = typing.value;
        typing.value = "";
        if(text)
        {
            emulator.keyboard_send_text(text);
        }
    });

    typing.addEventListener("keydown", function(e)
    {
        if(!emulator)
        {
            return;
        }
        if(e.key === "Backspace" && typing.value === "")
        {
            emulator.keyboard_send_scancodes(SCAN_BACKSPACE);
            e.preventDefault();
        }
        else if(e.key === "Enter")
        {
            emulator.keyboard_send_scancodes(SCAN_ENTER);
            e.preventDefault();
        }
    });

    set_running_controls(false);
    set_status("Выберите ISO-образ.");
    iso_input.disabled = false;
})();
