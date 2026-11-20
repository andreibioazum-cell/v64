import { dbg_log } from "../log.js";

// For Types Only
import { BusConnector } from "../bus.js";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 */
export function MouseAdapter(bus, screen_container)
{
    const SPEED_FACTOR = 1;

    // A finger that wanders less than this many CSS pixels is still a tap, not a drag
    const TOUCH_TAP_SLOP = 8;
    // A tap held longer than this is a right click, as on a phone
    const TOUCH_LONG_PRESS = 550;
    // How long a tap keeps the button down, so the guest sees a real click
    const TOUCH_CLICK_TIME = 60;
    // Vertical finger travel per wheel step while scrolling with two fingers
    const TOUCH_SCROLL_STEP = 16;

    var left_down = false,
        right_down = false,
        middle_down = false,

        last_x = 0,
        last_y = 0,

        touch_dragging = false,
        touch_moved = false,
        touch_pressed_at = 0,
        touch_press_x = 0,
        touch_press_y = 0,
        touch_scroll_y = 0,
        touch_click_timer = 0,

        mouse = this;

    // set by controller
    this.enabled = false;

    // set by emulator
    this.emu_enabled = true;

    // set by the guest's absolute pointing device driver
    this.absolute_mouse = false;

    // set by the page: the finger replaces the mouse (see set_touch_mode)
    this.touch_mode = false;

    this.bus = bus;

    this.bus.register("mouse-enable", function(enabled)
    {
        this.enabled = enabled;
        this.update_cursor();
    }, this);

    this.bus.register("vmware-absolute-mouse", function(enabled)
    {
        this.absolute_mouse = enabled;
        this.update_cursor();
    }, this);

    // TODO: Should probably not use bus for this
    this.is_running = false;
    this.bus.register("emulator-stopped", function()
    {
        this.is_running = false;
    }, this);
    this.bus.register("emulator-started", function()
    {
        this.is_running = true;
    }, this);

    this.update_cursor = function()
    {
        if(screen_container)
        {
            // In touch mode there is no host pointer at all: the only pointer on the
            // screen is the one the guest draws itself (if it draws one)
            const hide = this.touch_mode ||
                (this.absolute_mouse && this.enabled && this.emu_enabled);
            screen_container.style.cursor = hide ? "none" : "";
        }
    };

    /**
     * Turn the guest pointer into a phone-like finger: one finger drags the pointer, a
     * short tap clicks, a long press is a right click and two fingers scroll. While it
     * is on, the host hides its cursor, so nothing but the guest's own pointer is seen.
     *
     * @param {boolean} enabled
     */
    this.set_touch_mode = function(enabled)
    {
        this.touch_mode = !!enabled;

        if(typeof window !== "undefined")
        {
            remove_touch_listeners();
            add_touch_listeners();
        }

        mouse.update_cursor();
    };

    this.destroy = function()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        remove_touch_listeners();
        window.removeEventListener("mousemove", mousemove_handler, false);
        window.removeEventListener("mousedown", mousedown_handler, false);
        window.removeEventListener("mouseup", mouseup_handler, false);
        window.removeEventListener("wheel", mousewheel_handler, { passive: false });
        window.removeEventListener("contextmenu", contextmenu_handler, false);
        document.removeEventListener("pointerlockchange", pointerlockchange_handler, false);
    };

    function remove_touch_listeners()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        window.removeEventListener("touchstart", touch_start_handler, false);
        window.removeEventListener("touchstart", touch_press_handler, false);
        window.removeEventListener("touchmove", mousemove_handler, false);
        window.removeEventListener("touchmove", touch_drag_handler, false);
        window.removeEventListener("touchend", touch_end_handler, false);
        window.removeEventListener("touchend", touch_release_handler, false);
        window.removeEventListener("touchcancel", touch_end_handler, false);
        window.removeEventListener("touchcancel", touch_release_handler, false);
    }

    function add_touch_listeners()
    {
        if(typeof window === "undefined")
        {
            return;
        }

        if(mouse.touch_mode)
        {
            // Not passive: a finger on the screen must not scroll, zoom or select on the
            // page behind it. The touch move listener replaces the mouse one, because a
            // finger has to be interpreted as a finger, not as a hovering pointer.
            window.addEventListener("touchstart", touch_press_handler, { passive: false });
            window.addEventListener("touchmove", touch_drag_handler, { passive: false });
            window.addEventListener("touchend", touch_release_handler, false);
            window.addEventListener("touchcancel", touch_release_handler, false);
        }
        else
        {
            window.addEventListener("touchstart", touch_start_handler, false);
            window.addEventListener("touchmove", mousemove_handler, false);
            window.addEventListener("touchend", touch_end_handler, false);
            window.addEventListener("touchcancel", touch_end_handler, false);
        }
    }

    this.init = function()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        this.destroy();
        this.set_touch_mode(this.touch_mode);

        window.addEventListener("mousemove", mousemove_handler, false);
        window.addEventListener("mousedown", mousedown_handler, false);
        window.addEventListener("mouseup", mouseup_handler, false);
        window.addEventListener("wheel", mousewheel_handler, { passive: false });
        window.addEventListener("contextmenu", contextmenu_handler, false);
        document.addEventListener("pointerlockchange", pointerlockchange_handler, false);
    };
    this.init();

    function pointerlockchange_handler()
    {
        mouse.bus.send("mouse-pointer-lock", !!document.pointerLockElement);
    }

    function contextmenu_handler(e)
    {
        if(may_handle(e))
        {
            e.preventDefault();
        }
    }

    function is_child(child, parent)
    {
        while(child.parentNode)
        {
            if(child === parent)
            {
                return true;
            }
            child = child.parentNode;
        }

        return false;
    }

    function may_handle(e)
    {
        if(!mouse.enabled || !mouse.emu_enabled)
        {
            return false;
        }

        const MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY = true;

        if(MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY)
        {
            var parent = screen_container || document.body;
            return document.pointerLockElement || is_child(e.target, parent);
        }
        else
        {
            if(e.type === "mousemove" || e.type === "touchmove")
            {
                return true;
            }

            if(e.type === "mousewheel" || e.type === "DOMMouseScroll")
            {
                return is_child(e.target, parent);
            }

            return !e.target || e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA";
        }
    }

    function touch_start_handler(e)
    {
        if(may_handle(e))
        {
            var touches = e["changedTouches"];

            if(touches && touches.length)
            {
                var touch = touches[touches.length - 1];
                last_x = touch.clientX;
                last_y = touch.clientY;
            }
        }
    }

    function touch_end_handler(e)
    {
        if(left_down || middle_down || right_down)
        {
            mouse.bus.send("mouse-click", [false, false, false]);
            left_down = middle_down = right_down = false;
        }
    }

    // Touch mode ---------------------------------------------------------------

    // Only touches on the screen itself belong to the guest; the rest of the page keeps
    // scrolling normally.
    function touch_on_screen(e)
    {
        const parent = screen_container || document.body;
        return is_child(e.target, parent);
    }

    // Guests with an absolute pointing device follow this directly, so a tap lands
    // exactly where the finger was.
    function send_absolute(client_x, client_y)
    {
        if(!screen_container || typeof document === "undefined" || document.pointerLockElement)
        {
            return;
        }
        const rect = screen_container.getBoundingClientRect();
        mouse.bus.send("mouse-absolute", [
            client_x - rect.left, client_y - rect.top, rect.width, rect.height]);
    }

    function touch_press_handler(e)
    {
        const touches = e.changedTouches;

        if(!touches || !touches.length || !touch_on_screen(e))
        {
            return;
        }

        // Nothing on the page may scroll, zoom or scroll back while a finger is here
        if(e.cancelable)
        {
            e.preventDefault();
        }

        if(!may_handle(e))
        {
            return;
        }

        const touch = touches[touches.length - 1];
        last_x = touch.clientX;
        last_y = touch.clientY;

        if(e.touches && e.touches.length > 1)
        {
            // The second finger switches from moving the pointer to scrolling
            touch_dragging = false;
            touch_moved = true;
            touch_scroll_y = touch.clientY;
            return;
        }

        touch_dragging = true;
        touch_moved = false;
        touch_pressed_at = Date.now();
        touch_press_x = touch.clientX;
        touch_press_y = touch.clientY;
    }

    function touch_drag_handler(e)
    {
        const touches = e.changedTouches;

        if(!touches || !touches.length || !touch_on_screen(e))
        {
            return;
        }

        if(e.cancelable)
        {
            e.preventDefault();
        }

        if(!may_handle(e))
        {
            return;
        }

        const touch = touches[touches.length - 1];

        if(e.touches && e.touches.length > 1)
        {
            // Two fingers scroll; a finger moving down means "wheel up"
            const moved = touch.clientY - touch_scroll_y;
            touch_scroll_y = touch.clientY;

            const steps = Math.trunc(moved / TOUCH_SCROLL_STEP);

            if(steps)
            {
                mouse.bus.send("mouse-wheel", [steps, 0]);
            }
            return;
        }

        if(!touch_dragging)
        {
            return;
        }

        const delta_x = touch.clientX - last_x;
        const delta_y = touch.clientY - last_y;

        // A finger that barely moved is still a tap: do not nudge the pointer
        if(!touch_moved &&
            Math.abs(touch.clientX - touch_press_x) <= TOUCH_TAP_SLOP &&
            Math.abs(touch.clientY - touch_press_y) <= TOUCH_TAP_SLOP)
        {
            return;
        }

        touch_moved = true;
        last_x = touch.clientX;
        last_y = touch.clientY;

        mouse.bus.send("mouse-delta", [delta_x * SPEED_FACTOR, -delta_y * SPEED_FACTOR]);
        send_absolute(touch.clientX, touch.clientY);
    }

    function touch_release_handler(e)
    {
        if(e.cancelable)
        {
            e.preventDefault();
        }

        const tap = touch_dragging && !touch_moved && may_handle(e);
        const long_press = tap && Date.now() - touch_pressed_at >= TOUCH_LONG_PRESS;

        touch_dragging = false;
        touch_moved = false;

        if(tap)
        {
            send_absolute(touch_press_x, touch_press_y);
            touch_click(long_press);
            return;
        }

        // Ended mid drag or with two fingers: never leave a button pressed
        touch_end_handler(e);
    }

    // Press and release in quick succession, so the guest sees a real click
    function touch_click(right)
    {
        left_down = !right;
        right_down = !!right;
        middle_down = false;
        mouse.bus.send("mouse-click", [left_down, middle_down, right_down]);

        if(touch_click_timer)
        {
            clearTimeout(touch_click_timer);
        }
        touch_click_timer = setTimeout(function()
        {
            touch_click_timer = 0;
            touch_end_handler();
        }, TOUCH_CLICK_TIME);
    }

    function mousemove_handler(e)
    {
        if(!mouse.bus)
        {
            return;
        }

        if(!may_handle(e))
        {
            return;
        }

        if(!mouse.is_running)
        {
            return;
        }

        var delta_x = 0;
        var delta_y = 0;

        var touches = e["changedTouches"];

        if(touches)
        {
            if(touches.length)
            {
                var touch = touches[touches.length - 1];
                delta_x = touch.clientX - last_x;
                delta_y = touch.clientY - last_y;

                last_x = touch.clientX;
                last_y = touch.clientY;

                e.preventDefault();
            }
        }
        else
        {
            if(typeof e["movementX"] === "number")
            {
                delta_x = e["movementX"];
                delta_y = e["movementY"];
            }
            else if(typeof e["webkitMovementX"] === "number")
            {
                delta_x = e["webkitMovementX"];
                delta_y = e["webkitMovementY"];
            }
            else if(typeof e["mozMovementX"] === "number")
            {
                delta_x = e["mozMovementX"];
                delta_y = e["mozMovementY"];
            }
            else
            {
                // Fallback for other browsers?
                delta_x = e.clientX - last_x;
                delta_y = e.clientY - last_y;

                last_x = e.clientX;
                last_y = e.clientY;
            }
        }

        delta_x *= SPEED_FACTOR;
        delta_y *= SPEED_FACTOR;

        //if(Math.abs(delta_x) > 100 || Math.abs(delta_y) > 100)
        //{
        //    // Large mouse delta, drop?
        //}

        delta_y = -delta_y;

        // NOTE: affected by https://issues.chromium.org/issues/40737979
        //       Causes cursor jumps on multi-monitor and/or 120+ HZ monitors

        mouse.bus.send("mouse-delta", [delta_x, delta_y]);

        // Under pointer lock the page coordinates don't change, so no
        // meaningful absolute position can be reported
        if(!document.pointerLockElement)
        {
            send_absolute(e.clientX, e.clientY);
        }
    }

    function mousedown_handler(e)
    {
        if(may_handle(e))
        {
            click_event(e, true);
        }
    }

    function mouseup_handler(e)
    {
        if(may_handle(e))
        {
            click_event(e, false);
        }
    }

    function click_event(e, down)
    {
        if(!mouse.bus)
        {
            return;
        }

        if(e.which === 1)
        {
            left_down = down;
        }
        else if(e.which === 2)
        {
            middle_down = down;
        }
        else if(e.which === 3)
        {
            right_down = down;
        }
        else
        {
            dbg_log("Unknown event.which: " + e.which);
        }
        mouse.bus.send("mouse-click", [left_down, middle_down, right_down]);
        e.preventDefault();
    }

    function mousewheel_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var delta_x = e.wheelDelta || -e.detail;
        var delta_y = 0;

        if(delta_x < 0)
        {
            delta_x = -1;
        }
        else if(delta_x > 0)
        {
            delta_x = 1;
        }

        mouse.bus.send("mouse-wheel", [delta_x, delta_y]);
        e.preventDefault();
    }
}
