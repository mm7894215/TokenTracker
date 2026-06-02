using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace TokenTrackerWin;

/// <summary>
/// Renders the tray + pet context menus to match the dashboard's shared Select
/// dropdown (<c>dashboard/src/ui/components/Select.jsx</c>) exactly:
///   • popup: rounded-xl (12px), 1px gray-200 border, white bg
///   • item:  rounded-lg (8px), reserved left check column
///   • selected (Checked) row: gray-100 bg + gray-500 check + oai-black text
///   • hover row: gray-50 bg
///   • unselected text: gray-600
///
/// Light palette uses the Select's exact oai-gray values (OKLCH → sRGB). The
/// dashboard's *dark* gray scale is inverted in a way that makes the Select popup
/// render near-white with invisible selected text, so the dark palette here is a
/// sane dark equivalent rather than a literal copy.
/// </summary>
internal sealed class TrayMenuRenderer : ToolStripProfessionalRenderer
{
    private const int MenuCornerRadius = 12;   // Select popup rounded-xl
    private const int ItemCornerRadius = 8;    // Select item rounded-lg

    public sealed record Palette(
        Color MenuBackground,
        Color ItemHover,
        Color ItemSelected,
        Color Text,
        Color TextStrong,
        Color DisabledText,
        Color Border,
        Color Indicator);

    // Sane dark equivalent (the Select's literal dark values are broken — see remarks).
    public static readonly Palette DarkPalette = new(
        MenuBackground: Color.FromArgb(28, 28, 30),
        ItemHover: Color.FromArgb(44, 44, 47),
        ItemSelected: Color.FromArgb(54, 54, 58),
        Text: Color.FromArgb(165, 171, 165),
        TextStrong: Color.FromArgb(245, 247, 245),
        DisabledText: Color.FromArgb(110, 112, 114),
        Border: Color.FromArgb(62, 62, 66),
        Indicator: Color.FromArgb(150, 156, 150));

    // Exact Select (light) values: oai-gray-* (OKLCH hue 145) converted to sRGB.
    public static readonly Palette LightPalette = new(
        MenuBackground: Color.FromArgb(255, 255, 255),   // bg-white
        ItemHover: Color.FromArgb(246, 249, 246),        // gray-50
        ItemSelected: Color.FromArgb(238, 244, 238),     // gray-100
        Text: Color.FromArgb(77, 89, 77),                // gray-600
        TextStrong: Color.FromArgb(10, 10, 10),          // oai-black
        DisabledText: Color.FromArgb(149, 163, 149),     // gray-400
        Border: Color.FromArgb(216, 225, 216),           // gray-200
        Indicator: Color.FromArgb(103, 118, 103));       // gray-500

    private readonly TrayMenuColorTable _colorTable;
    private Palette _palette;

    public Palette Colors => _palette;

    public TrayMenuRenderer(Palette? palette = null) : this(new TrayMenuColorTable(), palette ?? DarkPalette)
    {
    }

    private TrayMenuRenderer(TrayMenuColorTable colorTable, Palette palette) : base(colorTable)
    {
        _colorTable = colorTable;
        _colorTable.Renderer = this;
        _palette = palette;
        RoundedEdges = true;
    }

    public void SetPalette(Palette palette)
    {
        _palette = palette;
    }

    public static Palette PaletteFor(bool light) => light ? LightPalette : DarkPalette;

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedRectangle(new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1), MenuCornerRadius);
        using var brush = new SolidBrush(_palette.MenuBackground);
        e.Graphics.FillPath(brush, path);
    }

    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
    {
        using var brush = new SolidBrush(_palette.MenuBackground);
        e.Graphics.FillRectangle(brush, e.AffectedBounds);
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (e.Item is not ToolStripMenuItem item) return;

        var bounds = new Rectangle(Point.Empty, item.Size);
        bounds.Inflate(-5, -2);

        // Select dropdown: hovered row = gray-50, selected (Checked) row = gray-100.
        Color color;
        if (item.Selected) color = _palette.ItemHover;
        else if (item.Checked) color = _palette.ItemSelected;
        else color = _palette.MenuBackground;

        if (color != _palette.MenuBackground)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var path = RoundedRectangle(bounds, ItemCornerRadius);
            using var brush = new SolidBrush(color);
            e.Graphics.FillPath(brush, path);
        }
        else
        {
            using var clear = new SolidBrush(_palette.MenuBackground);
            e.Graphics.FillRectangle(clear, new Rectangle(Point.Empty, item.Size));
        }
    }

    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
    {
        // Submenu expand arrow: follow the theme text colour (the default dark glyph
        // is invisible on the dark menu background).
        e.ArrowColor = _palette.Text;
        base.OnRenderArrow(e);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        // Match the Select: selected row = strong (oai-black) text, others = gray-600.
        var checkedRow = e.Item is ToolStripMenuItem { Checked: true };
        var color = !e.Item.Enabled
            ? _palette.DisabledText
            : checkedRow ? _palette.TextStrong : _palette.Text;
        // The framework's check-margin column provides the left gutter, so the laid-out
        // text rect is already correctly indented.
        var rect = new Rectangle(
            e.TextRectangle.Left,
            0,
            e.TextRectangle.Width,
            e.Item.Height);
        TextRenderer.DrawText(
            e.Graphics,
            e.Text,
            e.TextFont,
            rect,
            color,
            TextFormatFlags.Left
                | TextFormatFlags.VerticalCenter
                | TextFormatFlags.EndEllipsis
                | TextFormatFlags.NoPrefix);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        var y = e.Item.Height / 2;
        using var pen = new Pen(_palette.Border);
        e.Graphics.DrawLine(pen, 10, y, e.Item.Width - 10, y);
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        var rect = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedRectangle(rect, MenuCornerRadius);
        using var pen = new Pen(_palette.Border);
        e.Graphics.DrawPath(pen, path);
    }

    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        // Gray check in the framework's check-margin column, like the Select dropdown's
        // ItemIndicator. The check margin is reserved + counted in the menu width, so
        // (unlike item Padding) it adds a left gutter without overflowing the layout.
        if (e.Item is not ToolStripMenuItem { Checked: true }) return;
        var rect = e.ImageRectangle;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(_palette.Indicator, 1.9f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };
        // The framework hands us a small glyph rect jammed against the row's left edge,
        // leaving the ✓ cramped against the menu border. Nudge it right into the (ample)
        // gap before the text so it has breathing room on its left.
        const float CheckShiftX = 7f;
        float cx = rect.Left + rect.Width / 2f + CheckShiftX;
        // Center on the full row height — the framework's glyph rect isn't vertically
        // centered in the row, which left the ✓ sitting high.
        float cy = e.Item.Height / 2f;
        e.Graphics.DrawLines(pen, new[]
        {
            new PointF(cx - 4f, cy + 1f),
            new PointF(cx - 1f, cy + 4f),
            new PointF(cx + 5f, cy - 4f),
        });
    }

    private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        var arc = new Rectangle(bounds.Location, new Size(diameter, diameter));

        path.AddArc(arc, 180, 90);
        arc.X = bounds.Right - diameter;
        path.AddArc(arc, 270, 90);
        arc.Y = bounds.Bottom - diameter;
        path.AddArc(arc, 0, 90);
        arc.X = bounds.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void ApplyRoundedRegion(ToolStrip toolStrip)
    {
        if (toolStrip.Width <= 0 || toolStrip.Height <= 0) return;

        using var path = RoundedRectangle(
            new Rectangle(0, 0, toolStrip.Width, toolStrip.Height),
            MenuCornerRadius);
        var old = toolStrip.Region;
        toolStrip.Region = new Region(path);
        old?.Dispose();

        TryApplyDwmCorners(toolStrip.Handle);
    }

    private static void TryApplyDwmCorners(nint hwnd)
    {
        if (hwnd == 0) return;
        try
        {
            var preference = DWMWCP_ROUNDSMALL;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
        }
        catch { /* older Windows or unsupported popup window */ }
    }

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUNDSMALL = 3;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);

    private sealed class TrayMenuColorTable : ProfessionalColorTable
    {
        public TrayMenuRenderer? Renderer { get; set; }

        private Palette Colors => Renderer?._palette ?? DarkPalette;

        public override Color ToolStripDropDownBackground => Colors.MenuBackground;
        public override Color ImageMarginGradientBegin => Colors.MenuBackground;
        public override Color ImageMarginGradientMiddle => Colors.MenuBackground;
        public override Color ImageMarginGradientEnd => Colors.MenuBackground;
        public override Color MenuBorder => Colors.Border;
        public override Color MenuItemBorder => Colors.ItemHover;
        public override Color MenuItemSelected => Colors.ItemHover;
        public override Color MenuItemSelectedGradientBegin => Colors.ItemHover;
        public override Color MenuItemSelectedGradientEnd => Colors.ItemHover;
        public override Color MenuItemPressedGradientBegin => Colors.ItemSelected;
        public override Color MenuItemPressedGradientMiddle => Colors.ItemSelected;
        public override Color MenuItemPressedGradientEnd => Colors.ItemSelected;
        public override Color SeparatorDark => Colors.Border;
        public override Color SeparatorLight => Colors.Border;
    }
}
