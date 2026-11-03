/**
 * Touch target size. On a coarse pointer, `touchTarget` grows an element's hit area to at least 44x44 px with an
 * ::after box centred on it, so dense controls keep their drawn size. The element must be positioned
 * (`relative`) and must not use ::after for anything else. A fine pointer (mouse) keeps the exact drawn box.
 *
 * `min(0px, (100% - 44px) / 2)` is negative only when the element is smaller than 44 px on that axis; percentages
 * on `inset` resolve against the element itself here (it is the ::after's containing block).
 */
export const touchTarget =
    "pointer-coarse:after:absolute pointer-coarse:after:inset-[min(0px,calc((100%_-_44px)_/_2))] pointer-coarse:after:content-['']";
