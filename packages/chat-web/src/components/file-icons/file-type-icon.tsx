/**
 * File and folder icons by name. Design (docs/spec/file-icons.md): the rounded Phosphor file shape from @chat/icons
 * carries every type. Top types use the drawn Phosphor file glyph (FileTs, FilePdf, ...); the long tail uses the plain
 * file with a one or two character monogram; named folders carry a small inner glyph. One accent per family comes
 * from the --ficon-* tokens. Regular is the outline weight, fill is the solid weight for selected or active rows.
 */
import {
    AppWindow,
    ArrowsClockwise,
    BookOpen,
    BracketsAngle,
    Browser,
    Clock,
    Cloud,
    Code,
    Cube,
    Database,
    DeviceMobile,
    File,
    FileArchive,
    FileAudio,
    FileC,
    FileCode,
    FileCpp,
    FileCSharp,
    FileCss,
    FileCsv,
    FileDashed,
    FileDoc,
    FileHtml,
    FileImage,
    FileIni,
    FileJpg,
    FileJs,
    FileJsx,
    FileLock,
    FileMd,
    FilePdf,
    FilePng,
    FilePpt,
    FilePy,
    FileRs,
    FileSql,
    FileSvg,
    FileText,
    FileTs,
    FileTsx,
    FileTxt,
    FileVideo,
    FileVue,
    FileXls,
    FileZip,
    Flask,
    Folder,
    FolderOpen,
    Gear,
    GearSix,
    GitBranch,
    Globe,
    Hammer,
    HardDrives,
    IconContext,
    Image,
    Key,
    Layout,
    Lightbulb,
    ListBullets,
    Lock,
    MusicNotes,
    Package,
    Palette,
    Plugs,
    Table,
    Terminal,
    TextAa,
    Translate,
    Trash,
    UploadSimple,
    FilmStrip,
    Wrench,
    type Icon,
    type IconProps,
    type IconWeight,
} from "@pikvm/icons";
import { useContext, type CSSProperties, type ReactNode } from "react";
import { resolveFile, resolveFolder, type FileLook, type ResolveInput } from "./resolve";

const GLYPHS: Record<string, Icon> = {
    Js: FileJs,
    Jsx: FileJsx,
    Ts: FileTs,
    Tsx: FileTsx,
    Vue: FileVue,
    Html: FileHtml,
    Css: FileCss,
    Sql: FileSql,
    Csv: FileCsv,
    Py: FilePy,
    Rs: FileRs,
    C: FileC,
    Cpp: FileCpp,
    CSharp: FileCSharp,
    Ini: FileIni,
    Md: FileMd,
    Txt: FileTxt,
    Text: FileText,
    Pdf: FilePdf,
    Doc: FileDoc,
    Xls: FileXls,
    Ppt: FilePpt,
    Image: FileImage,
    Jpg: FileJpg,
    Png: FilePng,
    Svg: FileSvg,
    Audio: FileAudio,
    Video: FileVideo,
    Archive: FileArchive,
    Zip: FileZip,
    Lock: FileLock,
    Code: FileCode,
    Dashed: FileDashed,
};

const FOLDER_GLYPHS: Record<string, Icon> = {
    AppWindow,
    ArrowsClockwise,
    BookOpen,
    BracketsAngle,
    Browser,
    Clock,
    Cloud,
    Code,
    Cube,
    Database,
    DeviceMobile,
    FilmStrip,
    Flask,
    Gear,
    GearSix,
    GitBranch,
    Globe,
    Hammer,
    HardDrives,
    Image,
    Key,
    Layout,
    Lightbulb,
    ListBullets,
    Lock,
    MusicNotes,
    Package,
    Palette,
    Plugs,
    Table,
    Terminal,
    TextAa,
    Translate,
    Trash,
    UploadSimple,
    Wrench,
};

export interface FileTypeIconProps extends Omit<IconProps, "color" | "children"> {
    /** File name or path. The last segment decides the icon. */
    name: string;
    /** MIME type, used when the name has no known extension. */
    mime?: string;
    /** Leading bytes or text, used when the name and MIME type say nothing. */
    head?: ResolveInput["head"];
    /** Keep the current text colour instead of the family accent. */
    plain?: boolean;
}

const familyColour = (family: string, plain?: boolean): CSSProperties =>
    plain || family === "neutral" ? {} : { color: `var(--ficon-${family})` };

/** Font size (in the 256 unit icon grid) for a monogram of this length. */
const labelSize = (n: number) => (n <= 1 ? 104 : n === 2 ? 84 : 66);

/**
 * Draw `Base` with `overlay` painted above it. The shared icon component paints its children below its paths, which
 * would hide an overlay on the fill weight, so the base sits in a nested svg and the overlay follows it.
 */
function Layered({
    Base,
    weight,
    overlay,
    size = "1em",
    style,
    dataAttr,
    ...rest
}: {
    Base: Icon;
    weight: IconWeight;
    overlay: ReactNode;
    dataAttr: Record<string, string>;
} & Omit<IconProps, "color" | "children" | "weight">) {
    const { alt, ...svg } = rest;
    const labelled = Boolean(alt || svg["aria-label"] || svg["aria-labelledby"]);
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 256 256"
            fill="currentColor"
            role={labelled ? "img" : undefined}
            aria-hidden={labelled ? undefined : true}
            focusable="false"
            style={style}
            {...dataAttr}
            {...svg}
        >
            {alt ? <title>{alt}</title> : null}
            <Base weight={weight} size={256} />
            {overlay}
        </svg>
    );
}

function Monogram({ label, solid }: { label: string; solid: boolean }) {
    return (
        <text
            x={128}
            y={162}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={labelSize(label.length)}
            fontWeight={700}
            fontFamily="inherit"
            fill={solid ? "var(--surface)" : "currentColor"}
            stroke="none"
        >
            {label}
        </text>
    );
}

export function FileTypeIcon({ name, mime, head, plain, weight, style, ...rest }: FileTypeIconProps) {
    const look = resolveFile({ name, mime, head });
    const context = useContext(IconContext);
    return <LookIcon look={look} weight={weight ?? context.weight} plain={plain} style={style} {...rest} />;
}

/** Draw a resolved look. Exported so the coverage harness can render a look without a file name. */
export function LookIcon({
    look,
    weight = "regular",
    plain,
    style,
    ...rest
}: { look: FileLook; plain?: boolean } & Omit<IconProps, "color" | "children">) {
    const Glyph = look.glyph ? GLYPHS[look.glyph] : undefined;
    const Base = Glyph ?? File;
    const solid = weight === "fill";
    return (
        <Layered
            Base={Base}
            weight={weight}
            style={{ ...familyColour(look.family, plain), ...style }}
            dataAttr={{ "data-file-icon": look.id }}
            overlay={!Glyph && look.label ? <Monogram label={look.label} solid={solid} /> : null}
            {...rest}
        />
    );
}

export interface FolderTypeIconProps extends Omit<IconProps, "color" | "children"> {
    name: string;
    open?: boolean;
    plain?: boolean;
}

export function FolderTypeIcon({ name, open = false, plain, weight, style, ...rest }: FolderTypeIconProps) {
    const look = resolveFolder(name);
    const context = useContext(IconContext);
    const w: IconWeight = weight ?? context.weight ?? "regular";
    const Base = open ? FolderOpen : Folder;
    const Inner = look.glyph ? FOLDER_GLYPHS[look.glyph] : undefined;
    return (
        <Layered
            Base={Base}
            weight={w}
            style={{ ...familyColour(look.family, plain), ...style }}
            dataAttr={{ "data-folder-icon": look.id }}
            overlay={
                Inner ? (
                    <Inner
                        x={88}
                        y={open ? 118 : 104}
                        size={80}
                        weight={w === "fill" ? "fill" : "regular"}
                        color={w === "fill" ? "var(--surface)" : "currentColor"}
                    />
                ) : null
            }
            {...rest}
        />
    );
}

/** Glyph names this module can draw. The coverage harness checks every table row against them. */
export const KNOWN_FILE_GLYPHS: ReadonlySet<string> = new Set(Object.keys(GLYPHS));
export const KNOWN_FOLDER_GLYPHS: ReadonlySet<string> = new Set(Object.keys(FOLDER_GLYPHS));
