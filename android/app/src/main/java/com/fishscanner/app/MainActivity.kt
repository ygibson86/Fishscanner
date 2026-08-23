package com.fishscanner.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.bumptech.glide.Glide
import com.fishscanner.app.databinding.ActivityMainBinding
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val client = OkHttpClient()
    private val prefs by lazy { getSharedPreferences("fishscanner", MODE_PRIVATE) }

    private var currentPhotoFile: File? = null
    private var currentPhotoUri: Uri? = null

    // --- Camera capture ---------------------------------------------------------
    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success && currentPhotoUri != null) {
            showPreview(currentPhotoUri!!)
        } else {
            setStatus("Съёмка отменена")
        }
    }

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchCamera() else setStatus("Нужен доступ к камере, чтобы сфотографировать рыбку")
    }

    // --- Gallery pick -------------------------------------------------------------
    private val pickFromGallery = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null) {
            currentPhotoUri = uri
            currentPhotoFile = null // We'll stream directly from the content Uri on upload
            showPreview(uri)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.serverAddressInput.setText(
            prefs.getString("server_address", "192.168.1.10:8015")
        )

        binding.takePhotoButton.setOnClickListener { onTakePhotoClicked() }
        binding.pickGalleryButton.setOnClickListener { pickFromGallery.launch("image/*") }
        binding.uploadButton.setOnClickListener { uploadPhoto() }
    }

    private fun onTakePhotoClicked() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            launchCamera()
        } else {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchCamera() {
        val photosDir = File(cacheDir, "captured_photos").apply { mkdirs() }
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val file = File(photosDir, "fish_$timestamp.jpg")
        currentPhotoFile = file
        currentPhotoUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        takePicture.launch(currentPhotoUri)
    }

    private fun showPreview(uri: Uri) {
        Glide.with(this).load(uri).into(binding.photoPreview)
        binding.uploadButton.isEnabled = true
        setStatus("Фото готово — можно отправлять")
    }

    private fun setStatus(text: String) {
        binding.statusText.text = text
    }

    private fun uploadPhoto() {
        val uri = currentPhotoUri
        if (uri == null) {
            setStatus("Сначала сфотографируйте или выберите рыбку")
            return
        }

        val address = binding.serverAddressInput.text.toString().trim()
        if (address.isEmpty()) {
            setStatus("Укажите адрес сервера, например 192.168.1.10:8015")
            return
        }
        prefs.edit().putString("server_address", address).apply()

        val bytes = try {
            contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: IOException) {
            null
        }
        if (bytes == null) {
            setStatus("Не удалось прочитать фото")
            return
        }

        binding.uploadButton.isEnabled = false
        setStatus("Отправляю рыбку на сервер…")

        val url = normalizeUrl(address)
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "photo", "fish.jpg",
                bytes.toRequestBody("image/jpeg".toMediaType())
            )
            .build()

        val request = Request.Builder().url("$url/api/fish").post(requestBody).build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.uploadButton.isEnabled = true
                    setStatus("Ошибка соединения: ${e.message}")
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val ok = response.isSuccessful
                val bodyText = response.body?.string() ?: ""
                runOnUiThread {
                    binding.uploadButton.isEnabled = true
                    if (ok) {
                        setStatus("🐟 Рыбка отправлена! Смотрите аквариум в браузере на $url")
                        Toast.makeText(this@MainActivity, "Рыбка добавлена в аквариум!", Toast.LENGTH_LONG).show()
                    } else {
                        setStatus("Сервер отклонил фото: $bodyText")
                    }
                }
            }
        })
    }

    private fun normalizeUrl(address: String): String {
        val trimmed = address.trim().trimEnd('/')
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "http://$trimmed"
        }
    }
}
