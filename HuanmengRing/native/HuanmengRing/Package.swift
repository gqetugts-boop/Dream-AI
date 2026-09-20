// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HuanmengRing",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "HuanmengRing",
            path: "Sources/HuanmengRing",
            swiftSettings: [
                .unsafeFlags(["-suppress-warnings"])
            ]
        )
    ]
)
