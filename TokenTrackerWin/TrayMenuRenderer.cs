using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace TokenTrackerWin;

internal sealed class TrayMenuRenderer : ToolStripProfessionalRenderer
{
    private const int MenuCornerRadius = 10;

    public sealed record Palette(
        Color MenuBackground,
        Color ItemHover,
        Color ItemPressed,
        Color Text,
        Color DisabledText,
        Color Separator,
        Color Border,
        Color CheckBackground,
        Color CheckForeground);

    public static readonly Palette DarkPalette = new(
        Color.FromArgb(22, 22, 23),
        Color.FromArgb(40, 40, 42),
        Color.FromArgb(48, 48, 50),
        Color.FromArgb(238, 238, 239),
        Color.FromArgb(120, 120, 124),
        Color.FromArgb(58, 58, 62),
        Color.FromArgb(76, 76, 82),
        Color.FromArgb(44, 159, 119),
        Color.White);

    public static readonly Palette LightPalette = new(
        Color.FromArgb(255, 255, 255),
        Color.FromArgb(244, 244, 245),
        Color.FromArgb(236, 236, 238),
        Color.FromArgb(28, 28, 30),
        Color.FromArgb(142, 142, 147),
        Color.FromArgb(224, 224, 226),
        Color.FromArgb(202, 202, 206),
        Color.FromArgb(31, 138, 105),
        Color.White);

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
        var color = item.Pressed ? _palette.ItemPressed : item.Selected ? _palette.ItemHover : _palette.MenuBackground;

        if (color == _palette.MenuBackground)
        {
            using var clear = new SolidBrush(_palette.MenuBackground);
            e.Graphics.FillRectangle(clear, new Rectangle(Point.Empty, item.Size));
            return;
        }

        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedRectangle(bounds, 6);
        using var brush = new SolidBrush(color);
        e.Graphics.FillPath(brush, path);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        var color = e.Item.Enabled ? _palette.Text : _palette.DisabledText;
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
        using var pen = new Pen(_palette.Separator);
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
        var rect = e.ImageRectangle;
        rect.Inflate(2, 2);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedRectangle(rect, 4);
        using var brush = new SolidBrush(_palette.CheckBackground);
        e.Graphics.FillPath(brush, path);

        using var pen = new Pen(_palette.CheckForeground, 1.7f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
        };
        var x = rect.Left + rect.Width * 0.28f;
        var y = rect.Top + rect.Height * 0.52f;
        e.Graphics.DrawLines(pen, new[]
        {
            new PointF(x, y),
            new PointF(rect.Left + rect.Width * 0.45f, rect.Bottom - rect.Height * 0.28f),
            new PointF(rect.Right - rect.Width * 0.22f, rect.Top + rect.Height * 0.30f),
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
        public override Color MenuItemPressedGradientBegin => Colors.ItemPressed;
        public override Color MenuItemPressedGradientMiddle => Colors.ItemPressed;
        public override Color MenuItemPressedGradientEnd => Colors.ItemPressed;
        public override Color SeparatorDark => Colors.Separator;
        public override Color SeparatorLight => Colors.Separator;
    }
}
