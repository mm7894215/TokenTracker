import AppKit

/// Builds small template-silhouette frames for the menu bar from a pet's
/// sprite atlas (same 192×208-cell grid as `PetAtlasSpriteView`).
///
/// Colored sprites can't go into the menu bar as-is — the system expects
/// template images that tint with the bar's light/dark appearance. Each frame
/// is downsampled to 18pt (nearest-neighbor, keeping the pixel-art look) and
/// converted to an alpha-only silhouette: dark pixels stay opaque, light
/// pixels fade toward `alphaFloor` so interior details (eyes, markings)
/// survive as lighter cut-throughs, mirroring how the Clawd icon punches out
/// its eyes.
@MainActor
final class MenuBarPetFrameProvider {

    struct FrameSet {
        let idle: [NSImage]        // atlas row 0
        let active: [NSImage]      // atlas row 7 (typing/working)
        let sleeping: [NSImage]    // atlas row 6
        let disconnected: NSImage  // atlas row 5, frame 0
    }

    // Atlas geometry — must match PetAtlasSpriteView / pet-packages.js.
    private static let cellWidth = 192
    private static let cellHeight = 208
    private static let idleRow = 0
    private static let activeRow = 7
    private static let sleepRow = 6
    private static let errorRow = 5
    private static let framesPerRow = 6

    // Menu bar target: 18pt tall at a 2x backing scale.
    private static let targetPixelHeight = 36
    private static let targetPixelWidth = 33  // 192:208 aspect

    // Silhouette tuning (single place to iterate on readability).
    // Two hard levels instead of a continuous ramp: continuous alpha made the
    // icon read as blurry gray mush at 18pt. Solid body + punched-through
    // details keeps the pixel-art crispness of the Clawd icon.
    private static let detailLumaThreshold: CGFloat = 0.55
    private static let detailAlpha: CGFloat = 0.35
    private static let coverageThreshold: CGFloat = 0.4

    private var cache: (key: String, frames: FrameSet)?

    /// Returns nil for Clawd (no atlas — the animator falls back to its
    /// procedural frames) or when the atlas fails to load.
    func frames(for character: PetCharacter) -> FrameSet? {
        guard let url = character.atlasURL else { return nil }
        let key = character.atlasCacheKey
        if let cache, cache.key == key { return cache.frames }

        guard let image = NSImage(contentsOf: url),
              let atlas = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        let idle = buildRow(atlas: atlas, row: Self.idleRow)
        let active = buildRow(atlas: atlas, row: Self.activeRow)
        let sleeping = buildRow(atlas: atlas, row: Self.sleepRow)
        let disconnected = buildFrame(atlas: atlas, row: Self.errorRow, column: 0)
        guard !idle.isEmpty, !active.isEmpty, !sleeping.isEmpty,
              let disconnected else { return nil }

        let frames = FrameSet(idle: idle, active: active, sleeping: sleeping, disconnected: disconnected)
        cache = (key, frames)
        return frames
    }

    private func buildRow(atlas: CGImage, row: Int) -> [NSImage] {
        (0..<Self.framesPerRow).compactMap { buildFrame(atlas: atlas, row: row, column: $0) }
    }

    private func buildFrame(atlas: CGImage, row: Int, column: Int) -> NSImage? {
        let rect = CGRect(
            x: column * Self.cellWidth,
            y: row * Self.cellHeight,
            width: Self.cellWidth,
            height: Self.cellHeight
        )
        guard let cell = atlas.cropping(to: rect),
              let small = downsample(cell),
              let silhouette = silhouette(of: small) else { return nil }

        let image = NSImage(
            cgImage: silhouette,
            size: NSSize(width: CGFloat(Self.targetPixelWidth) / 2, height: CGFloat(Self.targetPixelHeight) / 2)
        )
        image.isTemplate = true
        return image
    }

    private func downsample(_ cell: CGImage) -> CGImage? {
        let width = Self.targetPixelWidth
        let height = Self.targetPixelHeight
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(cell, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()
    }

    /// Alpha-only conversion: out alpha = srcAlpha × max(floor, 1 − luma).
    private func silhouette(of image: CGImage) -> CGImage? {
        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        guard let ctx = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        for i in stride(from: 0, to: pixels.count, by: 4) {
            let alpha = CGFloat(pixels[i + 3]) / 255
            let outAlpha: CGFloat
            if alpha < Self.coverageThreshold {
                // Drop anti-aliased fringe pixels entirely — keeps edges crisp.
                outAlpha = 0
            } else {
                // Values are premultiplied; dividing by alpha recovers true luma.
                let r = CGFloat(pixels[i]) / 255 / alpha
                let g = CGFloat(pixels[i + 1]) / 255 / alpha
                let b = CGFloat(pixels[i + 2]) / 255 / alpha
                let luma = min(1, 0.299 * r + 0.587 * g + 0.114 * b)
                outAlpha = luma < Self.detailLumaThreshold ? 1 : Self.detailAlpha
            }
            pixels[i] = 0
            pixels[i + 1] = 0
            pixels[i + 2] = 0
            pixels[i + 3] = UInt8((outAlpha * 255).rounded())
        }

        guard let out = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        return out.makeImage()
    }
}
