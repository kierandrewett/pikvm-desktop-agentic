import { createContext, forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps, useContext } from "react";

/** Weights shipped by this package. Phosphor's thin, light and duotone weights are not generated. */
export type IconWeight = "regular" | "fill" | "bold";

/** Path data for each weight. Most icons have one path; a few fill icons have several. */
export type IconPaths = Readonly<Record<IconWeight, readonly string[]>>;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | "color"> {
    /** Width and height. Numbers are pixels. Default "1em", as in @phosphor-icons/react. */
    size?: number | string;
    weight?: IconWeight;
    /** Fill colour. Default currentColor. */
    color?: string;
    /** Flip horizontally, for icons with a direction in right-to-left layouts. */
    mirrored?: boolean;
    /** Accessible name rendered as <title>, as in @phosphor-icons/react. Prefer aria-label. */
    alt?: string;
}

export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/**
 * Build one icon component. Generated modules call this once at module level, marked pure, so bundlers drop
 * every icon that is not imported.
 *
 * Accessibility: with aria-label, aria-labelledby or alt the svg is an image with a name (role="img").
 * Without a name it is decoration and is hidden from assistive technology.
 */
/**
 * Default weight for icons below a provider. An explicit `weight` prop always wins, so components can
 * set a house style (for example solid icons inside buttons) without overriding deliberate choices.
 */
export const IconContext = createContext<{ weight?: IconWeight }>({});

/**
 * Optical size exceptions: glyphs whose ink is much smaller than the shared 256 grid suggests (three
 * small dots) read as undersized next to other icons at the same box size. The viewBox is cropped
 * around the centre, so the glyph draws larger (1.1x is +2px at 20px) while the box, and so layout,
 * stays the same.
 */
const OPTICAL_SCALE: Readonly<Record<string, number>> = {
    DotsThree: 1.1,
    DotsThreeVertical: 1.1,
};

function viewBoxFor(name: string): string {
    const scale = OPTICAL_SCALE[name];
    if (!scale) return "0 0 256 256";
    const side = 256 / scale;
    const offset = (256 - side) / 2;
    return `${offset} ${offset} ${side} ${side}`;
}

export function createIcon(name: string, paths: IconPaths): Icon {
    const viewBox = viewBoxFor(name);
    const component = forwardRef<SVGSVGElement, IconProps>(function IconSvg(props, ref) {
        const context = useContext(IconContext);
        const {
            size = "1em",
            weight = context.weight ?? "regular",
            color = "currentColor",
            mirrored = false,
            alt,
            children,
            ...rest
        } = props;
        const labelled = Boolean(alt || rest["aria-label"] || rest["aria-labelledby"]);
        // Fall back to regular for weights this package does not ship (untyped callers).
        const data = paths[weight] ?? paths.regular;
        return (
            <svg
                ref={ref}
                xmlns="http://www.w3.org/2000/svg"
                width={size}
                height={size}
                viewBox={viewBox}
                fill={color}
                transform={mirrored ? "scale(-1, 1)" : undefined}
                role={labelled ? "img" : undefined}
                aria-hidden={labelled ? undefined : true}
                focusable="false"
                {...rest}
            >
                {alt ? <title>{alt}</title> : null}
                {children}
                {data.map((d) => (
                    <path key={d} d={d} />
                ))}
            </svg>
        );
    });
    component.displayName = name;
    return component;
}
