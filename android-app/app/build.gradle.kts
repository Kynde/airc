import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing config from a git-ignored android-app/keystore.properties:
//   storeFile=airc-release.jks
//   storePassword=...
//   keyAlias=airc
//   keyPassword=...
// Absent (most checkouts, CI without secrets) -> release builds fall back to the
// debug key, so `assembleRelease` still produces an installable APK; only the
// official release artifact uploaded to GitHub is signed with the real key.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

// `git describe` captured at configuration time and baked into BuildConfig so the
// installed APK can report which build it is (the device has no git/repo). Falls back to
// a short hash when untagged and gains `-dirty` for a modified work tree; "unknown" when
// built outside a git tree. providers.exec runs from android-app/, inside the repo.
fun gitDescribe(): String = try {
    providers.exec {
        commandLine("git", "describe", "--tags", "--always", "--dirty")
    }.standardOutput.asText.get().trim().ifEmpty { "unknown" }
} catch (e: Exception) {
    "unknown"
}

android {
    namespace = "dev.airc.tmuxremote"
    compileSdk = 35

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "dev.airc.tmuxremote"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "GIT_DESCRIBE", "\"${gitDescribe()}\"")
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            // Use the real release key when keystore.properties is present;
            // otherwise leave the default (debug) signing so the build still runs.
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
