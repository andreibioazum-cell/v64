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
    var hdd_file = null;
    var hdd_pending = false;
    var paused = false;
    var booted = false;

    var el = function(id) { return document.getElementById(id); };
    var iso_input = el("iso");
    var iso_name = el("iso_name");
    var hdd_input = el("hdd");
    var hdd_name = el("hdd_name");
    var start_btn = el("start");
    var pause_btn = el("pause");
    var reset_btn = el("reset");
    var cad_btn = el("cad");
    var fullscreen_btn = el("fullscreen");
    var typing = el("typing");
    var status = el("status");
    var ram_select = el("ram");
    var log_lines = el("log_lines");
    var log_copy_btn = el("log_copy");
    var log_clear_btn = el("log_clear");
    var iso_clear_btn = el("iso_clear");
    var hdd_clear_btn = el("hdd_clear");
    var progress_el = el("progress");
    var progress_fill = el("progress_fill");
    var progress_percent_el = el("progress_percent");
    var progress_label_el = el("progress_label");

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

    function format_size(bytes)
    {
        if(bytes >= 1024 * MiB)
        {
            return (bytes / (1024 * MiB)).toFixed(1) + " ГиБ";
        }
        if(bytes >= MiB)
        {
            return Math.round(bytes / MiB) + " МиБ";
        }
        return Math.max(1, Math.round(bytes / 1024)) + " КиБ";
    }

    // The bar under the page shows how far the boot got: reading the images, starting
    // the machine, the BIOS hand-off, and then the guest itself.
    function set_progress(percent, label, level)
    {
        progress_value = Math.max(0, Math.min(100, Math.round(percent)));

        if(progress_fill)
        {
            progress_fill.style.width = progress_value + "%";
        }
        if(progress_percent_el)
        {
            progress_percent_el.textContent = progress_value + "%";
        }
        if(progress_label_el)
        {
            progress_label_el.textContent = label || "";
            progress_label_el.title = label || "";
        }
        if(progress_el)
        {
            progress_el.classList.toggle("progress_err", level === "err");
            progress_el.classList.toggle("progress_done", level === "done");
            progress_el.setAttribute("aria-valuenow", String(progress_value));
        }
    }

    // Milestones can arrive out of order (restarts, late listeners); never go back.
    function raise_progress(percent, label, level)
    {
        if(percent > progress_value)
        {
            set_progress(percent, label, level);
        }
    }

    function short_failure()
    {
        var reasons = [];

        if(hdd_file && hdd_problem)
        {
            reasons.push("диск «" + hdd_file.name + "»: " + hdd_problem);
        }
        if(iso_file && iso_problem)
        {
            reasons.push("CD «" + iso_file.name + "»: " + iso_problem);
        }

        return reasons.length ? reasons.join("; ") : "BIOS не нашёл загрузочный носитель";
    }

    // v86 reads the whole image into memory for files below 256 MiB anyway, but without
    // any feedback. Doing it here shows real percentages instead of a frozen page.
    function read_file_with_progress(file, on_progress)
    {
        return new Promise(function(resolve, reject)
        {
            var buffer = new ArrayBuffer(file.size);
            var view = new Uint8Array(buffer);
            var offset = 0;

            function next()
            {
                if(offset >= file.size)
                {
                    resolve(buffer);
                    return;
                }

                var end = Math.min(offset + READ_CHUNK, file.size);
                var reader = new FileReader();

                reader.onload = function(e)
                {
                    view.set(new Uint8Array(e.target.result), offset);
                    offset = end;
                    on_progress(offset, file.size);
                    next();
                };
                reader.onerror = function()
                {
                    reject(new Error("не удалось прочитать «" + file.name + "»"));
                };
                reader.readAsArrayBuffer(file.slice(offset, end));
            }

            if(file.size === 0)
            {
                resolve(buffer);
                return;
            }

            next();
        });
    }

    // v86 boots the image itself, so the boot sector has to be at offset 0: container
    // formats (qcow2, VMDK, ...) and non-ISO9660 CD images only fail much later inside
    // the BIOS, with no hint for the user. Everything that can be decided by reading a
    // few sectors is written to the log and to the label next to the file button.
    var CONTAINER_FORMATS = {
        qcow: "qcow/qcow2", qcow2: "qcow/qcow2", qcow3: "qcow/qcow2",
        vmdk: "VMDK", vdi: "VDI", vhd: "VHD", vhdx: "VHDX",
    };

    var CONTAINER_MAGICS = [
        { bytes: [0x51, 0x46, 0x49, 0xFB], name: "qcow/qcow2" },
        { bytes: [0x4B, 0x44, 0x4D, 0x56], name: "VMDK" },
        { bytes: [0x7F, 0x10, 0xDA, 0xBE], name: "VDI" },
        { bytes: [0x63, 0x6F, 0x6E, 0x65, 0x63, 0x74, 0x69, 0x78], name: "VHD" },
    ];

    var LOG_LIMIT = 500;

    var hdd_problem = "";
    var iso_problem = "";
    var hdd_stub = false;
    var hdd_data = null;
    var iso_data = null;
    var progress_value = 0;

    // Images up to this size are read into memory by the page itself, so the bar can
    // show how much of the file is loaded. Bigger ones are streamed by v86.
    var READ_LIMIT = 256 * MiB;
    var READ_CHUNK = 4 * MiB;

    function file_extension(name)
    {
        var dot = name.lastIndexOf(".");
        return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
    }

    function starts_with(bytes, magic)
    {
        if(bytes.length < magic.length)
        {
            return false;
        }
        for(var i = 0; i < magic.length; i++)
        {
            if(bytes[i] !== magic[i])
            {
                return false;
            }
        }
        return true;
    }

    function le32(bytes, offset)
    {
        return ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0);
    }

    function hex2(value)
    {
        return (value < 16 ? "0" : "") + value.toString(16).toUpperCase();
    }

    function hex_dump(bytes, offset, length)
    {
        var out = [];
        for(var i = 0; i < length && offset + i < bytes.length; i++)
        {
            out.push(hex2(bytes[offset + i]));
        }
        return out.join(" ");
    }

    function has_boot_signature(bytes, offset)
    {
        return bytes.length >= offset + 2 && bytes[offset] === 0x55 && bytes[offset + 1] === 0xAA;
    }

    function has_ascii(bytes, offset, text)
    {
        if(bytes.length < offset + text.length)
        {
            return false;
        }
        for(var i = 0; i < text.length; i++)
        {
            if(bytes[offset + i] !== text.charCodeAt(i))
            {
                return false;
            }
        }
        return true;
    }

    function is_iso9660(head)
    {
        return has_ascii(head, 0x8001, "CD001");
    }

    function read_range(file, offset, length, callback)
    {
        var end = Math.min(offset + length, file.size);

        if(offset >= file.size || end <= offset)
        {
            callback(new Uint8Array(0));
            return;
        }

        var reader = new FileReader();
        reader.onload = function(e)
        {
            callback(new Uint8Array(e.target.result));
        };
        reader.onerror = function()
        {
            callback(new Uint8Array(0));
        };
        reader.readAsArrayBuffer(file.slice(offset, end));
    }

    // The log is what tells the user why a boot failed: what was read from the image
    // and what the BIOS answered afterwards.
    function log(kind, text, level)
    {
        if(!log_lines)
        {
            return;
        }

        var line = document.createElement("div");
        line.className = "log_line" + (level ? " log_" + level : "");

        var time = document.createElement("span");
        time.className = "log_time";
        time.textContent = now_stamp();

        var kind_span = document.createElement("span");
        kind_span.className = "log_kind";
        kind_span.textContent = kind;

        var text_span = document.createElement("span");
        text_span.className = "log_text";
        text_span.textContent = text;

        line.appendChild(time);
        line.appendChild(kind_span);
        line.appendChild(text_span);
        log_lines.appendChild(line);

        while(log_lines.childElementCount > LOG_LIMIT)
        {
            log_lines.removeChild(log_lines.firstElementChild);
        }

        log_lines.scrollTop = log_lines.scrollHeight;
    }

    function two_digits(value)
    {
        return (value < 10 ? "0" : "") + value;
    }

    function now_stamp()
    {
        var date = new Date();
        return two_digits(date.getHours()) + ":" + two_digits(date.getMinutes()) + ":" + two_digits(date.getSeconds());
    }

    function log_text_all()
    {
        var lines = [];

        if(!log_lines)
        {
            return "";
        }

        for(var i = 0; i < log_lines.childElementCount; i++)
        {
            var line = log_lines.children[i];
            lines.push(
                line.querySelector(".log_time").textContent + " " +
                line.querySelector(".log_kind").textContent + ": " +
                line.querySelector(".log_text").textContent
            );
        }
        return lines.join("\n");
    }

    function clear_log()
    {
        if(log_lines)
        {
            log_lines.textContent = "";
        }
    }

    // Some images ship with a placeholder boot sector that simply spins. The BIOS
    // accepts it as a bootable disk, so the screen just stops with no error at all.
    function describe_boot_code(head)
    {
        if(head[0] === 0xEB && head[1] === 0xFE)
        {
            return "`jmp $` (EB FE): бесконечный переход на самое себя";
        }
        if(head[0] === 0xE9 && head[1] === 0xFD && head[2] === 0xFF)
        {
            return "`jmp $` (E9 FD FF): бесконечный переход на самое себя";
        }
        if(head[0] === 0xFA && head[1] === 0xF4)
        {
            return "`cli` + `hlt` (FA F4): прерывания выключены, процессор остановлен";
        }
        if(head[0] === 0xF4)
        {
            return "`hlt` (F4): процессор останавливается сразу";
        }
        return "";
    }

    function describe_filesystem(sector)
    {
        if(has_ascii(sector, 3, "NTFS    "))
        {
            return "NTFS";
        }
        if(has_ascii(sector, 3, "EXFAT   "))
        {
            return "exFAT";
        }
        if(has_ascii(sector, 0x52, "FAT32"))
        {
            return "FAT32";
        }
        if(has_ascii(sector, 0x36, "FAT16") || has_ascii(sector, 0x36, "FAT12"))
        {
            return "FAT";
        }
        if(sector.length >= 0x43A && sector[0x438] === 0x53 && sector[0x439] === 0xEF)
        {
            return "ext2/3/4";
        }
        return "";
    }

    function bootable_partitions(mbr)
    {
        var partitions = [];
        for(var i = 0; i < 4; i++)
        {
            var base = 446 + i * 16;
            var type = mbr[base + 4];
            if(type)
            {
                partitions.push({
                    index: i + 1,
                    active: mbr[base] === 0x80,
                    type: type,
                    start: le32(mbr, base + 8),
                    count: le32(mbr, base + 12),
                });
            }
        }
        return partitions;
    }

    function report_disk(file, head, done)
    {
        var kind = "диск";

        if(head.length < 512)
        {
            log(kind, "файл короче 512 байт — загрузочного сектора в нём нет", "err");
            done("файл короче 512 байт, загрузочного сектора в нём нет");
            return;
        }

        if(file.size % 512)
        {
            log(kind, "размер " + format_size(file.size) + " не кратен 512 байтам — образ обрезан или это не raw-образ диска", "warn");
        }
        else
        {
            log(kind, "размер " + format_size(file.size) + ", " + (file.size / 512) + " секторов по 512 байт");
        }

        if(!has_boot_signature(head, 510))
        {
            log(kind, "в первых 512 байтах нет 0x55AA — BIOS ответит «Boot failed: not a bootable disk»", "err");

            if(has_ascii(head, 0x8001, "CD001"))
            {
                log(kind, "в секторе 16 лежит ISO9660 — это CD-образ, выберите его кнопкой «Выбрать ISO»", "warn");
                done("это CD-образ (ISO9660), а не жёсткий диск — выберите его кнопкой «Выбрать ISO»");
            }
            else
            {
                done("в первых 512 байтах нет сигнатуры 0x55AA, BIOS не загрузится с этого образа");
            }
            return;
        }

        log(kind, "загрузочная сигнатура 0x55AA на месте", "ok");
        log(kind, "первые 16 байт загрузочного сектора: " + hex_dump(head, 0, 16));

        var stub = describe_boot_code(head);

        if(stub)
        {
            hdd_stub = true;
            log(kind, "в загрузочном секторе заглушка — " + stub + ". BIOS передаст ей управление, " +
                "и машина остановится без вывода и без ошибки", "err");
            done("загрузочный сектор — заглушка `jmp $`, загружаться нечему");
            return;
        }

        var code_bytes = 0;
        for(i = 0; i < 510; i++)
        {
            if(head[i])
            {
                code_bytes++;
            }
        }

        if(code_bytes === 0)
        {
            log(kind, "в загрузочном секторе нет кода: все 510 байт — нули, BIOS передаст управление пустому сектору, и машина зависнет без вывода", "err");
            done("загрузочный сектор пустой (нули), загружаться нечему");
            return;
        }

        if(code_bytes > 480 && head[0] === 0xFF)
        {
            log(kind, "загрузочный сектор заполнен 0xFF — кода в нём нет, BIOS передаст управление мусору", "err");
            done("загрузочный сектор заполнен 0xFF, загружаться нечему");
            return;
        }

        if(head[0] === 0x00)
        {
            log(kind, "первый байт загрузочного сектора — 0x00: это не начало кода, скорее всего сектор не загрузочный", "warn");
        }

        if(has_ascii(head, 512, "EFI PART"))
        {
            log(kind, "найдена таблица разделов GPT (BIOS читает MBR-часть, см. ниже)");
        }

        var partitions = bootable_partitions(head);

        if(!partitions.length)
        {
            var filesystem = describe_filesystem(head);

            if(filesystem)
            {
                log(kind, "таблица разделов MBR пустая, зато в секторе 0 лежит " + filesystem +
                    " — это superfloppy-образ без таблицы разделов, BIOS загрузит сектор 0 как есть");
            }
            else
            {
                log(kind, "таблица разделов MBR пустая и знакомой файловой системы в секторе 0 нет — " +
                    "если у образа своя схема разметки, это нормально, иначе он вряд ли загрузочный", "warn");
            }
            done("");
            return;
        }

        for(var i = 0; i < partitions.length; i++)
        {
            var partition = partitions[i];
            log(kind, "раздел " + partition.index + ": тип 0x" + hex2(partition.type) +
                ", начало LBA " + partition.start +
                ", размер " + format_size(partition.count * 512) +
                (partition.active ? ", помечен активным" : ""));
        }

        var primary = partitions[0];
        for(i = 0; i < partitions.length; i++)
        {
            if(partitions[i].active)
            {
                primary = partitions[i];
                break;
            }
        }

        var offset = primary.start * 512;

        if(offset + 512 > file.size)
        {
            log(kind, "раздел " + primary.index + " начинается по LBA " + primary.start + ", а это за концом файла — образ обрезан", "err");
            done("таблица разделов указывает за конец файла, образ обрезан");
            return;
        }

        read_range(file, offset, 512, function(sector)
        {
            var filesystem = describe_filesystem(sector);
            var suffix = filesystem ? " (" + filesystem + ")" : "";

            if(has_boot_signature(sector, 510))
            {
                log(kind, "загрузочная запись раздела " + primary.index + " (LBA " + primary.start + ") содержит 0x55AA" + suffix + " — BIOS сможет загрузиться с раздела", "ok");
                done("");
            }
            else
            {
                log(kind, "в загрузочной записи раздела " + primary.index + " (LBA " + primary.start + ") нет 0x55AA" + suffix + " — с него не загрузиться", "err");
                done("первый сектор раздела без сигнатуры 0x55AA, загрузка не пойдёт");
            }
        });
    }

    function report_cd(file, done)
    {
        read_range(file, 0, 0x8006, function(head)
        {
            var kind = "CD";

            log(kind, "размер " + format_size(file.size));

            if(!is_iso9660(head))
            {
                log(kind, "ISO9660 не найден: в секторе 16 нет «CD001» — BIOS ответит «Boot failed: Could not read from CDROM (code 0004)»", "err");
                if(has_boot_signature(head, 510))
                {
                    log(kind, "зато в первых 512 байтах есть 0x55AA — это образ диска, выберите его кнопкой «Выбрать HDD»", "warn");
                    done("это образ диска (0x55AA), а не CD — выберите его кнопкой «Выбрать HDD»");
                }
                else
                {
                    done("в образе нет ISO9660 (CD001), BIOS не сможет с него загрузиться");
                }
                return;
            }

            log(kind, "ISO9660 найден (CD001 в секторе 16; всего " + Math.floor(file.size / 2048) + " секторов по 2048 байт)", "ok");

            read_range(file, 0x8800, 0x800, function(boot_record)
            {
                if(has_ascii(boot_record, 7, "EL TORITO SPECIFICATION"))
                {
                    var catalog = le32(boot_record, 0x47);
                    log(kind, "есть загрузочная запись El Torito, каталог загрузки в секторе " + catalog + " — BIOS сможет загрузиться с CD", "ok");

                    if(catalog && catalog * 2048 >= file.size)
                    {
                        log(kind, "но каталог загрузки указывает за конец файла — образ обрезан", "err");
                    }
                    done("");
                }
                else
                {
                    log(kind, "нет загрузочной записи El Torito (сектор 17, «EL TORITO SPECIFICATION») — BIOS ответит «Boot failed: Could not read from CDROM (code 0004)»", "err");
                    done("в образе нет El Torito (загрузочной записи), BIOS не сможет с него загрузиться");
                }
            });
        });
    }

    // Reads the first sectors of a freshly chosen image, writes the findings to the log
    // and returns one short reason for the label next to the file button.
    function report_image(file, is_cdrom, done)
    {
        var kind = is_cdrom ? "CD" : "диск";
        var container = CONTAINER_FORMATS[file_extension(file.name)];

        log(kind, "выбран файл " + file.name + " (" + format_size(file.size) + ", " + file.size + " байт)");

        read_range(file, 0, 1024, function(head)
        {
            for(var i = 0; i < CONTAINER_MAGICS.length && !container; i++)
            {
                if(starts_with(head, CONTAINER_MAGICS[i].bytes))
                {
                    container = CONTAINER_MAGICS[i].name;
                }
            }

            if(container)
            {
                log(kind, "это контейнер " + container + " (сигнатура в первых байтах) — v86 работает только с raw-образами", "err");
                log(kind, "файл подключён как есть, поэтому BIOS не увидит ни таблицы разделов, ни загрузочной записи; " +
                    "переконвертируйте: qemu-img convert -O raw \"" + file.name + "\" disk.img", "warn");
                done("это образ " + container + ", а v86 читает только raw-образы (нужен .img/.raw, например qemu-img convert -O raw)");
                return;
            }

            if(is_cdrom)
            {
                report_cd(file, done);
            }
            else
            {
                report_disk(file, head, done);
            }
        });
    }

    // Shows the file name and, once the header is read, why it may not boot.
    function select_image(file, is_cdrom, name_element)
    {
        var label = file.name + " (" + format_size(file.size) + ")";
        var current = function()
        {
            return is_cdrom ? iso_file : hdd_file;
        };

        name_element.textContent = label;

        if(is_cdrom)
        {
            iso_data = null;
        }
        else
        {
            // The verdict below replaces whatever the previous image was.
            hdd_stub = false;
            hdd_data = null;
        }

        report_image(file, is_cdrom, function(problem)
        {
            if(is_cdrom)
            {
                iso_problem = problem;
            }
            else
            {
                hdd_problem = problem;
            }

            if(current() !== file)
            {
                // Another image was picked in the meantime.
                return;
            }
            name_element.textContent = problem ? label + " — " + problem : label;

            if(problem)
            {
                set_progress(progress_value, "образ не загрузочный — " + problem, "err");
            }
            else if(!emulator)
            {
                set_progress(0, "Образ готов. Нажмите «Запустить»");
            }
        });
    }

    function clear_media(is_cdrom)
    {
        if(emulator)
        {
            log(is_cdrom ? "CD" : "диск",
                "образ уже подключён к запущенной машине — чтобы сменить или убрать его, перезагрузите страницу", "warn");
            return;
        }

        if(is_cdrom)
        {
            iso_file = null;
            iso_problem = "";
            iso_data = null;
            iso_input.value = "";
            iso_name.textContent = "ISO не выбран";
            iso_clear_btn.disabled = true;
        }
        else
        {
            hdd_file = null;
            hdd_problem = "";
            hdd_stub = false;
            hdd_data = null;
            hdd_input.value = "";
            hdd_name.textContent = "жёсткий диск не выбран";
            hdd_clear_btn.disabled = true;
        }

        log(is_cdrom ? "CD" : "диск", "выбор образа сброшен");
        update_start_gate();
        set_progress(0, boot_media_selected() ? "Образ готов. Нажмите «Запустить»" : "Выберите ISO-образ или образ жёсткого диска");
        set_status(boot_media_selected() ? "Образ выбран. Нажмите «Запустить»." : "Выберите ISO-образ или образ жёсткого диска.");
    }

    function verdict_text()
    {
        var reasons = [];

        if(hdd_file && hdd_problem)
        {
            reasons.push("жёсткий диск «" + hdd_file.name + "»: " + hdd_problem);
        }
        if(iso_file && iso_problem)
        {
            reasons.push("CD «" + iso_file.name + "»: " + iso_problem);
        }

        if(!reasons.length)
        {
            return "ни один носитель не загрузочный; в образах нет явных проблем — возможно, в них нет загрузчика или он падает";
        }

        return "ни один носитель не загрузочный — " + reasons.join("; ");
    }

    // The BIOS prints why it could not boot, but only as its own terse messages.
    // Watching the text screen lets the page repeat those lines in the log and add the
    // explanation for each of them.
    var bios_timer = null;
    var bios_rows = [];
    var bios_logged = {};

    var BIOS_LINE = /^(SeaBIOS|Booting from|Boot failed|No bootable|Could not read|Retrying|Press |iPXE|Escape|error:|Error:)/;

    // The BIOS says "Booting from ..." and then nothing at all: either the guest is
    // working silently (graphics mode, or just quiet) or its boot code is stuck in a
    // loop. Telling the user which one it is saves them from a blank screen.
    var HANG_SECONDS = 10;

    var handoff_time = 0;
    var hang_reported = false;
    var serial_line = "";
    var serial_lines = 0;
    var SERIAL_LINES_LIMIT = 200;
    var graphical_mode = false;
    var last_screen_change = 0;
    var hang_timer = null;

    function stop_bios_watch()
    {
        if(bios_timer)
        {
            clearInterval(bios_timer);
            bios_timer = null;
        }
        if(hang_timer)
        {
            clearInterval(hang_timer);
            hang_timer = null;
        }
    }

    function start_bios_watch()
    {
        stop_bios_watch();
        bios_rows = [];
        bios_logged = {};
        handoff_time = 0;
        hang_reported = false;
        graphical_mode = false;
        serial_line = "";
        last_screen_change = Date.now();

        bios_timer = setInterval(function()
        {
            var adapter = emulator && emulator.screen_adapter;

            if(!adapter || typeof adapter.get_text_screen !== "function")
            {
                return;
            }

            var rows;

            try
            {
                rows = adapter.get_text_screen();
            }
            catch(err)
            {
                return;
            }

            for(var i = 0; i < rows.length; i++)
            {
                var line = (rows[i] || "").replace(/\s+$/, "");

                if(line === bios_rows[i])
                {
                    continue;
                }
                bios_rows[i] = line;

                last_screen_change = Date.now();

                var trimmed = line.replace(/^\s+/, "");
                if(trimmed && BIOS_LINE.test(trimmed))
                {
                    log_bios_line(trimmed);
                }
                else if(trimmed && handoff_time)
                {
                    // Something other than the BIOS is printing: the guest got going.
                    raise_progress(100, "гость работает — идёт загрузка ОС", "done");
                }
            }
        }, 300);

        hang_timer = setInterval(check_hang, 1000);
    }

    // Hobby systems usually print their progress to COM1 instead of the screen.
    function on_serial_byte(byte)
    {
        if(serial_lines >= SERIAL_LINES_LIMIT)
        {
            return;
        }

        if(byte === 10 || byte === 13)
        {
            var text = serial_line.replace(/\s+$/, "");
            serial_line = "";

            if(text)
            {
                serial_lines++;
                log("COM1", text);
                last_screen_change = Date.now();
                raise_progress(100, "гость работает — идёт загрузка ОС", "done");
            }
            return;
        }

        if(byte >= 32 && byte < 127 && serial_line.length < 300)
        {
            serial_line += String.fromCharCode(byte);
            last_screen_change = Date.now();
        }
    }

    function check_hang()
    {
        if(!emulator || !handoff_time || hang_reported || graphical_mode)
        {
            return;
        }

        var silent = Math.round((Date.now() - last_screen_change) / 1000);

        if(silent < HANG_SECONDS)
        {
            return;
        }

        hang_reported = true;

        log("BIOS", "гость принял управление " + silent + " с назад и не вывел ничего нового — загрузочный код, похоже, завис " +
            "(нет ни вывода, ни перезагрузки)", "warn");
        set_progress(progress_value, "не грузится — загрузочный код молчит после передачи управления", "err");
        set_status("Не грузится — загрузочный код молчит после передачи управления");
        if(hdd_problem || iso_problem)
        {
            log("итог", verdict_text(), "err");
        }
        else
        {
            log("итог", "машина жива, но делает что-то молча. Если образ должен что-то показать, дело в его загрузочном секторе: " +
                "смотрите дамп первых байт выше — код, который ждёт ключа или чтения с диска, выглядит именно так", "warn");
        }
    }

    function log_bios_line(text)
    {
        var now = Date.now();

        // The same message is re-rendered when the screen scrolls; do not repeat it.
        if(bios_logged[text] && now - bios_logged[text] < 2000)
        {
            return;
        }
        bios_logged[text] = now;

        if(/^Booting from (Hard Disk|DVD\/CD|Floppy)/.test(text))
        {
            // The BIOS is about to jump into the boot code of that medium.
            handoff_time = Date.now();
            last_screen_change = handoff_time;
            hang_reported = false;
            raise_progress(75, "BIOS передал управление загрузочному сектору");
        }
        else if(/^(Boot failed|No bootable device)/.test(text))
        {
            // Not a handoff after all: the BIOS keeps trying other media.
            handoff_time = 0;
        }

        raise_progress(60, "BIOS загружается");

        log("BIOS", text);

        var note = explain_bios_line(text);
        if(note)
        {
            log("BIOS", "→ " + note, "err");
        }

        if(/^No bootable device/.test(text))
        {
            log("итог", verdict_text(), "err");
            set_progress(progress_value, "не грузится — " + short_failure(), "err");
            set_status("Не грузится — " + short_failure());
        }
    }

    function explain_bios_line(text)
    {
        if(/Boot failed: not a bootable disk/.test(text))
        {
            return "жёсткий диск не загрузочный: в его первом секторе нет корректной загрузочной записи (0x55AA)";
        }
        if(/Boot failed: could not read the boot disk/.test(text))
        {
            return "флоппи-диска нет или он не читается — это не ошибка выбранного образа";
        }
        if(/Boot failed: Could not read from CDROM/.test(text))
        {
            return "BIOS не нашёл на CD загрузочную запись El Torito — с этого образа загрузиться нельзя";
        }
        if(/^Booting from Hard Disk/.test(text))
        {
            return "BIOS передаёт управление загрузочной записи диска";
        }
        if(/^Booting from DVD\/CD/.test(text))
        {
            return "BIOS пробует CD: ищет El Torito/ISO9660";
        }
        if(/^Booting from Floppy/.test(text))
        {
            return "BIOS пробует флоппи: там нет носителя";
        }
        return "";
    }

    function log_boot_order()
    {
        var media = [];

        if(hdd_file)
        {
            media.push("жёсткий диск («" + hdd_file.name + "»)");
        }
        if(iso_file)
        {
            media.push("CD-ROM («" + iso_file.name + "»)");
        }
        if(!media.length)
        {
            return;
        }

        log("запуск", "порядок загрузки: " + media.join(" → "));

        if(hdd_file && iso_file)
        {
            log("запуск", "BIOS попробует жёсткий диск первым, CD — только если диск не загрузочный");
        }

        if(hdd_file && iso_file && hdd_stub)
        {
            log("запуск", "в загрузочном секторе диска заглушка, поэтому до CD дело не дойдёт — " +
                "если нужен CD, уберите диск крестиком рядом с его именем", "warn");
        }
    }

    // The machine boots from the hard disk when one is selected, from the CD otherwise,
    // so at least one of the two images is required.
    function boot_media_selected()
    {
        return !!(hdd_file || iso_file);
    }

    function update_start_gate()
    {
        start_btn.disabled = !boot_media_selected();
    }

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

    function selected_ram_mib()
    {
        return parseInt(ram_select.value, 10);
    }

    // Chrome reports device memory in GB (rounded, capped at 8); other browsers do not report it.
    // Guest RAM above half of the device memory is likely to fail, so warn about it.
    function ram_warning()
    {
        var device_gb = navigator.deviceMemory;
        var ram_mib = selected_ram_mib();
        if(device_gb && ram_mib > device_gb * 1024 / 2)
        {
            return "Внимание: браузер сообщает около " + device_gb + " ГБ памяти устройства, " + ram_mib + " МиБ для гостя может не запуститься.";
        }
        return "";
    }

    // Sizes the page offers, largest first. When guest RAM cannot be allocated the
    // page falls back to the next smaller size instead of leaving the user stuck.
    var RAM_SIZES_MIB = [2048, 1024, 512, 256];
    var ALLOCATION_ERROR = "Could not allocate";
    var started_ram_mib = 0;

    function next_smaller_ram(ram_mib)
    {
        var index = RAM_SIZES_MIB.indexOf(ram_mib);
        return index === -1 ? 0 : (RAM_SIZES_MIB[index + 1] || 0);
    }

    function on_start_failed(message)
    {
        emulator = window.emulator = null;
        paused = false;

        var smaller = next_smaller_ram(started_ram_mib);
        if(message.indexOf(ALLOCATION_ERROR) !== -1 && smaller)
        {
            set_status("Не удалось выделить " + started_ram_mib + " МиБ, пробую " + smaller + " МиБ…");
            start_with_ram(smaller);
            return;
        }

        ram_select.disabled = false;
        start_btn.disabled = false;
        set_running_controls(false);
        log("машина", "ошибка запуска: " + message, "err");
        set_progress(progress_value, "ошибка запуска: " + message, "err");
        set_status("Ошибка запуска: " + message + ". Выберите меньший объём ОЗУ и запустите снова.");
    }

    // Insert the image into the running machine and reboot from it. The promise resolves
    // once the geometry has been written to the CMOS, so the restart already sees the disk.
    function swap_hdd(file)
    {
        set_status("Загрузка образа жёсткого диска…");
        log("диск", "подключаю «" + file.name + "» на место жёсткого диска и перезагружаюсь");
        set_progress(50, "подключаю образ диска и перезагружаюсь");
        emulator.set_hda({ buffer: file }).then(function()
        {
            if(!emulator)
            {
                return;
            }
            emulator.restart();
            start_bios_watch();
            if(paused)
            {
                // The machine was paused; a reboot does not resume it by itself.
                emulator.run();
            }
            paused = false;
            set_status("Перезапуск с образа жёсткого диска");
            set_running_controls(true);
        }, function(err)
        {
            var message = err && err.message ? err.message : String(err);
            log("диск", "не удалось подключить образ: " + message, "err");
            set_status("Ошибка чтения образа жёсткого диска: " + message);
        });
    }

    // Reads whatever images are not in memory yet (with percentages in the bar) and
    // then starts the machine.
    function after_start()
    {
        if(!emulator)
        {
            return;
        }
        paused = false;
        set_status("Работает" + (ram_warning() ? ". " + ram_warning() : ""));
        set_running_controls(true);
    }

    function start_machine()
    {
        var pending = [];
        var total = 0;

        if(hdd_file && !hdd_data && hdd_file.size <= READ_LIMIT)
        {
            pending.push({ file: hdd_file, kind: "диск", assign: function(buffer) { hdd_data = buffer; } });
            total += hdd_file.size;
        }
        if(iso_file && !iso_data && iso_file.size <= READ_LIMIT)
        {
            pending.push({ file: iso_file, kind: "CD", assign: function(buffer) { iso_data = buffer; } });
            total += iso_file.size;
        }

        if(!pending.length)
        {
            set_progress(25, "образы готовы, запускаю машину");
            start_with_ram(selected_ram_mib());
            after_start();
            return;
        }

        var loaded_total = 0;
        var chain = Promise.resolve();

        set_progress(0, "чтение образов");

        pending.forEach(function(item)
        {
            chain = chain.then(function()
            {
                set_progress(total ? loaded_total / total * 25 : 0,
                    "чтение «" + item.file.name + "» (" + format_size(item.file.size) + ")");

                return read_file_with_progress(item.file, function(loaded)
                {
                    set_progress((loaded_total + loaded) / total * 25,
                        "чтение «" + item.file.name + "»: " + format_size(loaded) + " из " + format_size(item.file.size));
                }).then(function(buffer)
                {
                    item.assign(buffer);
                    loaded_total += item.file.size;
                    log(item.kind, "образ «" + item.file.name + "» прочитан в память (" + format_size(item.file.size) + ")");
                });
            });
        });

        chain.then(function()
        {
            set_progress(25, "образы прочитаны, запускаю машину");
            start_with_ram(selected_ram_mib());
            after_start();
        }, function(err)
        {
            var message = err && err.message ? err.message : String(err);
            log("ошибка", message, "err");
            set_progress(progress_value, "не удалось прочитать образ: " + message, "err");
            on_start_failed(message);
        });
    }

    function start_with_ram(ram_mib)
    {
        try
        {
            create_emulator(ram_mib);
        }
        catch(err)
        {
            on_start_failed(err && err.message ? err.message : String(err));
        }
    }

    function create_emulator(ram_mib)
    {
        booted = false;
        started_ram_mib = ram_mib;
        ram_select.value = String(ram_mib);
        ram_select.disabled = true;

        emulator = window.emulator = new V86({
            wasm_fn: function(imports)
            {
                return WebAssembly.instantiate(wasm_bytes, imports).then(function(result)
                {
                    return result.instance.exports;
                });
            },
            screen_container: el("screen_container"),
            memory_size: ram_mib * MiB,
            vga_memory_size: 8 * MiB,
            bios: { buffer: seabios.buffer },
            vga_bios: { buffer: vgabios.buffer },
            // The hard disk goes first in the boot order when it is present; the
            // CD-ROM must be omitted entirely (not set to a null buffer) so that a
            // hard-disk-only start works.
            hda: hdd_data ? { buffer: hdd_data } : (hdd_file ? { buffer: hdd_file } : undefined),
            cdrom: iso_data ? { buffer: iso_data } : (iso_file ? { buffer: iso_file } : undefined),
            autostart: true,
            disable_speaker: true,
        });

        log("машина", "старт: ОЗУ гостя " + ram_mib + " МиБ");
        set_progress(40, "машина запущена, BIOS стартует");

        emulator.add_listener("serial0-output-byte", on_serial_byte);

        // Text mode reports [cols, rows, 0], graphics [width, height, bpp].
        emulator.add_listener("screen-set-size", function(args)
        {
            graphical_mode = !!(args && args[2]);

            if(graphical_mode)
            {
                raise_progress(100, "гость работает — идёт загрузка ОС", "done");
            }
        });

        emulator.add_listener("emulator-started", function()
        {
            booted = true;
            start_bios_watch();
            raise_progress(50, "машина запущена, BIOS стартует");
            if(hdd_pending)
            {
                // The disk was picked while the machine was still being created.
                hdd_pending = false;
                swap_hdd(hdd_file);
                return;
            }
            if(!paused)
            {
                set_status("Работает, ОЗУ гостя: " + started_ram_mib + " МиБ");
            }
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
        select_image(file, true, iso_name);
        iso_clear_btn.disabled = false;
        update_start_gate();

        if(emulator)
        {
            // Load the new image into the running machine and reboot from it.
            log("CD", "подключаю «" + file.name + "» в CD-ROM и перезагружаюсь");
            emulator.set_cdrom({ buffer: file });
            emulator.restart();
            start_bios_watch();
            paused = false;
            set_status("Перезапуск с нового образа");
            set_running_controls(true);
        }
        else
        {
            set_status("Образ выбран. Нажмите «Запустить».");
        }
    });

    hdd_input.addEventListener("change", function()
    {
        var file = hdd_input.files && hdd_input.files[0];
        if(!file)
        {
            return;
        }

        hdd_file = file;
        select_image(file, false, hdd_name);
        hdd_clear_btn.disabled = false;
        update_start_gate();

        if(emulator && booted)
        {
            swap_hdd(file);
        }
        else if(emulator)
        {
            // The machine is still being created, so its devices do not exist yet.
            // The disk is inserted as soon as it has started.
            hdd_pending = true;
            set_status("Машина запускается, диск будет подключён после старта.");
        }
        else
        {
            set_status(hdd_file && !iso_file ? "Образ жёсткого диска выбран. Нажмите «Запустить»." : "Образ выбран. Нажмите «Запустить».");
        }
    });

    start_btn.addEventListener("click", function()
    {
        if(!boot_media_selected())
        {
            set_status("Сначала выберите ISO-образ или образ жёсткого диска.");
            return;
        }

        start_btn.disabled = true;
        log_boot_order();

        if(!emulator)
        {
            // Reading the images is asynchronous, so the machine starts a few ticks later.
            start_machine();
            return;
        }

        try
        {
            emulator.run();
            paused = false;
            set_status("Работает");
            set_running_controls(true);
        }
        catch(err)
        {
            on_start_failed(err && err.message ? err.message : String(err));
        }
    });

    if(log_clear_btn)
    {
        log_clear_btn.addEventListener("click", clear_log);
    }

    if(iso_clear_btn)
    {
        iso_clear_btn.addEventListener("click", function()
        {
            clear_media(true);
        });
    }

    if(hdd_clear_btn)
    {
        hdd_clear_btn.addEventListener("click", function()
        {
            clear_media(false);
        });
    }

    if(log_copy_btn)
    {
        log_copy_btn.addEventListener("click", function()
        {
            var text = log_text_all();

            if(navigator.clipboard && navigator.clipboard.writeText)
            {
                navigator.clipboard.writeText(text).catch(function()
                {
                    set_status("Не удалось скопировать лог — выделите его мышью");
                });
                return;
            }

            var area = document.createElement("textarea");
            area.value = text;
            document.body.appendChild(area);
            area.select();

            try
            {
                document.execCommand("copy");
            }
            catch(err)
            {
                set_status("Не удалось скопировать лог — выделите его мышью");
            }

            document.body.removeChild(area);
        });
    }

    ram_select.addEventListener("change", function()
    {
        set_status(ram_warning() || "ОЗУ гостя: " + selected_ram_mib() + " МиБ. Изменить можно после перезагрузки страницы.");
    });

    // The V86 constructor starts the machine asynchronously (wasm and BIOS loading,
    // guest memory allocation), so a failure there surfaces as an unhandled rejection.
    window.addEventListener("unhandledrejection", function(e)
    {
        var reason = e.reason;
        var message = reason && reason.message ? reason.message : String(reason);
        log("ошибка", message, "err");
        set_progress(progress_value, "ошибка: " + message, "err");
        if(emulator && !booted)
        {
            on_start_failed(message);
        }
        else
        {
            set_status("Ошибка: " + message);
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
        log("машина", "перезагрузка по кнопке");
        set_progress(55, "перезагрузка");
        emulator.restart();
        start_bios_watch();
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

    // Narrow screens are usually phones with less RAM.
    ram_select.value = String(is_small_screen() ? 256 : 512);

    set_running_controls(false);
    set_progress(0, "Выберите ISO-образ или образ жёсткого диска");
    set_status("Выберите ISO-образ или образ жёсткого диска.");
    iso_input.disabled = false;
    hdd_input.disabled = false;
    ram_select.disabled = false;
})();
